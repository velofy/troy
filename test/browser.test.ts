import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveFixtures, SLOW_FAIL_MS, SLOW_PAGE_MS } from './server.js'
import type { TroyBridge } from '../src/browser/bridge.js'

// These tests run without the DOM lib, because everything else in the
// program is Node and Electron main. The chrome page's globals exist only
// inside the callbacks Playwright serializes into it, so they are declared
// here to the extent those callbacks actually use them.
declare const window: { troy: TroyBridge }

type ChromeElement = {
  getBoundingClientRect(): { width: number; height: number; top: number; left: number }
  setAttribute(name: string, value: string): void
  scrollWidth: number
  clientWidth: number
  hidden: boolean
  className: string
}

declare const document: {
  querySelector(selector: string): ChromeElement | null
  querySelectorAll(selector: string): Iterable<ChromeElement> & ArrayLike<ChromeElement>
}

/**
 * The battle tests. These drive the real application: a real Electron main
 * process, real Chromium tabs, real navigations over a real socket.
 *
 * They assert through two surfaces and no others. The chrome page is what a
 * person sees, so tab strip and omnibox assertions go through Playwright.
 * Which view is visible and where it sits is invisible from that page, so
 * those go through the TROY_TEST snapshot hook in the main process. Nothing
 * asserts on internals a user could not eventually notice.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

type TabInfo = {
  id: number
  url: string
  displayUrl: string
  title: string
  pending: string | null
  failed: { url: string; reason: string } | null
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

type Snapshot = {
  activeTabId: number
  panelOpen: boolean
  tabs: TabInfo[]
  contentBounds: { width: number; height: number } | null
}

let app: ElectronApplication
let chrome: Page
let fixtures: { url: string; close: () => Promise<void> }
let userDataDir: string
/** A port nothing is listening on, so connecting to it fails immediately. */
let deadUrl: string

/**
 * Bind an ephemeral port, note it, and give it straight back. Hardcoding a
 * low port instead lands on Chromium's blocked list (port 1 answers
 * ERR_UNSAFE_PORT, never ERR_CONNECTION_REFUSED), which tests the wrong path.
 */
async function findClosedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

beforeAll(async () => {
  fixtures = await serveFixtures()
  deadUrl = `http://127.0.0.1:${await findClosedPort()}/`
  userDataDir = await mkdtemp(path.join(tmpdir(), 'troy-test-'))
  app = await electron.launch({
    args: [path.join(root, 'src', 'browser', 'main.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, TROY_TEST: '1' },
  })
  chrome = await app.firstWindow()
  await chrome.waitForSelector('.tab', { timeout: 20_000 })
  // The tab strip appears as soon as the tab exists, which is before its
  // first page has committed. Wait for the navigation, not the widget.
  await until((s) => s.tabs[0]?.url.includes('newtab.html') === true, 'the new tab page to commit')
}, 60_000)

afterAll(async () => {
  await app?.close()
  await fixtures?.close()
  await rm(userDataDir, { recursive: true, force: true })
})

async function snapshot(): Promise<Snapshot> {
  return (await app.evaluate(() => {
    const hook = (globalThis as unknown as { __troy?: { snapshot(): unknown } }).__troy
    if (!hook) throw new Error('TROY_TEST snapshot hook is missing')
    return hook.snapshot()
  })) as Snapshot
}

/** Trigger a real application menu item, the way the accelerator does. */
async function menu(id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
}

/** Poll until the snapshot satisfies the predicate, or fail with what it saw. */
async function until(
  predicate: (snap: Snapshot) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  let last: Snapshot | null = null
  while (Date.now() < deadline) {
    last = await snapshot()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`timed out waiting for ${what}. Last snapshot: ${JSON.stringify(last, null, 2)}`)
}

function activeTab(snap: Snapshot): TabInfo {
  const tab = snap.tabs.find((t) => t.id === snap.activeTabId)
  if (!tab) throw new Error(`no active tab in ${JSON.stringify(snap)}`)
  return tab
}

/** Type an address and press Enter, exactly as a person would. */
async function omnibox(text: string): Promise<void> {
  await chrome.fill('#omni', text)
  await chrome.press('#omni', 'Enter')
}

/** Close every tab but the first, so each test starts from a known strip. */
async function resetToOneTab(): Promise<void> {
  let snap = await snapshot()
  for (const tab of snap.tabs.slice(1)) {
    await chrome.evaluate((id) => window.troy.closeTab(id), tab.id)
  }
  snap = await until((s) => s.tabs.length === 1, 'the strip to be back to one tab')
  await chrome.evaluate((id) => window.troy.selectTab(id), snap.tabs[0]!.id)
  await omnibox('about:blank')
  await until((s) => activeTab(s).url === 'about:blank', 'the tab to be parked on about:blank')
}

describe('the window', () => {
  it('opens with one tab, showing the new tab page and an empty omnibox', async () => {
    const snap = await snapshot()
    expect(snap.tabs).toHaveLength(1)
    expect(activeTab(snap).url).toContain('newtab.html')
    expect(activeTab(snap).displayUrl).toBe('')
    expect(await chrome.inputValue('#omni')).toBe('')
    expect(await chrome.locator('.tab').count()).toBe(1)
    expect(await chrome.locator('.tab.active .label').textContent()).toBe('New Tab')
  })

  it('lays the page out below the chrome and across the full window', async () => {
    const snap = await snapshot()
    const tab = activeTab(snap)
    expect(tab.bounds.y).toBe(88)
    expect(tab.bounds.x).toBe(0)
    expect(tab.bounds.width).toBe(snap.contentBounds?.width)
    expect(tab.visible).toBe(true)
  })
})

describe('the omnibox', () => {
  it('navigates to a page and shows its title and address', async () => {
    await omnibox(`${fixtures.url}/article.html`)
    const snap = await until(
      (s) => activeTab(s).title.includes('article'),
      'the article title to reach the tab strip',
    )
    expect(activeTab(snap).url).toBe(`${fixtures.url}/article.html`)
    expect(await chrome.inputValue('#omni')).toBe(`${fixtures.url}/article.html`)
    expect(await chrome.locator('.tab.active .label').textContent()).toContain('article')
  })

  it('refuses a javascript: URL and says so, instead of running it in the open page', async () => {
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).title.includes('article'), 'the article to load')

    await omnibox('javascript:alert(1)')
    await chrome.waitForSelector('#notice:not([hidden])', { timeout: 5000 })
    expect(await chrome.textContent('#notice')).toMatch(/will not open that/i)

    // and the tab it was typed into did not move
    const snap = await snapshot()
    expect(activeTab(snap).url).toBe(`${fixtures.url}/article.html`)
  })

  it('refuses about:config from a page navigation the same way the omnibox would', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the article')

    await app.evaluate(({ webContents }, target) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === target)
      return page?.executeJavaScript(`location.href = 'about:config'`, true)
    }, `${fixtures.url}/article.html`)

    await new Promise((resolve) => setTimeout(resolve, 400))
    const snap = await snapshot()
    expect(activeTab(snap).url).toBe(`${fixtures.url}/article.html`)
  })

  // Asserts the search was issued, not that Google answered. Reaching the
  // public internet would make the suite depend on the network and on a
  // third party being up, neither of which is what this test is about.
  it('issues a google search for a phrase rather than treating it as an address', async () => {
    await resetToOneTab()
    await omnibox('how tall is everest')
    const snap = await until(
      (s) => (activeTab(s).pending ?? '').startsWith('https://www.google.com/search'),
      'a google search to be issued',
    )
    expect(activeTab(snap).pending).toContain('how%20tall%20is%20everest')
  })
})

describe('the new tab page', () => {
  /** Type into the new tab page's own search box and submit it. */
  async function searchFromNewTab(text: string): Promise<void> {
    await app.evaluate(
      ({ webContents }, query) => {
        const page = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'))
        if (!page) throw new Error('no new tab page open')
        return page.executeJavaScript(
          `(() => {
            const box = document.getElementById('q')
            box.value = ${JSON.stringify(query)}
            box.form.requestSubmit()
          })()`,
          true,
        )
      },
      text,
    )
  }

  it('offers a search box that navigates the tab', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until(
      (s) => activeTab(s).url.includes('newtab.html'),
      'a fresh new tab page',
    )

    await searchFromNewTab(`${fixtures.url}/article.html`)
    const snap = await until(
      (s) => activeTab(s).url === `${fixtures.url}/article.html`,
      'the new tab search to navigate',
    )
    expect(activeTab(snap).failed).toBeNull()
  })

  it('searches a phrase typed into it rather than treating it as an address', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a fresh new tab page')

    await searchFromNewTab('how tall is everest')
    const snap = await until(
      (s) => (activeTab(s).pending ?? '').startsWith('https://www.google.com/search'),
      'a google search from the new tab page',
    )
    expect(activeTab(snap).pending).toContain('how%20tall%20is%20everest')
  })

  // The new tab box must not be a second, weaker front door.
  it('refuses javascript: from its search box, exactly like the address bar', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a fresh new tab page')

    await searchFromNewTab('javascript:alert(1)')
    await chrome.waitForSelector('#notice:not([hidden])', { timeout: 5000 })
    expect(await chrome.textContent('#notice')).toMatch(/will not open that/i)

    const snap = await snapshot()
    expect(activeTab(snap).url).toContain('newtab.html')
  })
})

describe('the new tab bridge', () => {
  /** Run script in whichever tab is showing the given URL fragment. */
  function inTab(fragment: string, code: string): Promise<unknown> {
    return app.evaluate(
      ({ webContents }, [needle, source]) => {
        const page = webContents.getAllWebContents().find((w) => w.getURL().includes(needle))
        if (!page) throw new Error(`no tab showing ${needle}`)
        return page.executeJavaScript(source, true)
      },
      [fragment, code] as [string, string],
    )
  }

  /**
   * The same, for script that navigates the tab.
   *
   * executeJavaScript resolves from the page it ran in, so awaiting a call
   * that navigates away waits for a reply that can never arrive. Awaiting it
   * turned a fast suite into a fifteen minute one.
   */
  function inTabNoWait(fragment: string, code: string): Promise<void> {
    return app.evaluate(
      ({ webContents }, [needle, source]) => {
        const page = webContents.getAllWebContents().find((w) => w.getURL().includes(needle))
        if (!page) throw new Error(`no tab showing ${needle}`)
        void page.executeJavaScript(source, true).catch(() => undefined)
      },
      [fragment, code] as [string, string],
    )
  }

  it('gives the new tab page its bridge', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a new tab page')
    expect(await inTab('newtab.html', 'typeof window.troyNewTab')).toBe('object')
  })

  // The preload is attached to every tab, so this is the property that
  // matters: an ordinary web page must not get the object at all.
  it('gives an ordinary web page nothing', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the article')
    expect(await inTab('/article.html', 'typeof window.troyNewTab')).toBe('undefined')
  })

  // Shortcuts were removed outright: the add dialog was broken for weeks and
  // a grid nobody can populate is worse than no grid. These two properties
  // survive the removal: the new tab page has no tile bridge left to call,
  // and nothing it might still reference can store or open a scripted URL.
  it('leaves the new tab page without a shortcut bridge', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a new tab page')

    // Poll: the bridge object appears once the tab's preload has run.
    const deadline = Date.now() + 10_000
    let surface: Record<string, string> = {}
    while (Date.now() < deadline) {
      surface = (await inTab(
        'newtab.html',
        `({ addShortcut: typeof window.troyNewTab.addShortcut, removeShortcut: typeof window.troyNewTab.removeShortcut, openTile: typeof window.troyNewTab.openTile })`,
      )) as Record<string, string>
      if (Object.keys(surface).length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(Object.values(surface).every((t) => t === 'undefined')).toBe(true)

    await inTabNoWait('newtab.html', `document.querySelector('.tile .face')?.click()`)
    const still = (await snapshot()).tabs.find((t) => t.url.includes('newtab.html'))
    expect(still).toBeTruthy()
  })
})

describe('the loading bar', () => {
  // Split on whitespace rather than using includes: the finished state adds
  // the class "done", and "done" contains "on".
  const progressOn = () =>
    chrome.evaluate(() => {
      const bar = document.querySelector('#progress')
      return bar ? bar.className.split(/\s+/).includes('on') : false
    })

  /** Wait until the bar has settled, so a previous navigation is not read. */
  async function barSettles(): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await progressOn())) return
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    throw new Error('the loading bar never cleared')
  }

  // The bug this exists for: the bar sat at top:88px, which is exactly where
  // the page's WebContentsView begins. It rendered correctly and was
  // composited underneath the page, so it was never once visible. Asserting
  // the class said "on" passed the whole time.
  it('sits inside the chrome, where the page view cannot cover it', async () => {
    const box = await chrome.evaluate(() => {
      const bar = document.querySelector('#progress')!.getBoundingClientRect()
      return { top: bar.top, bottom: bar.top + bar.height, height: bar.height }
    })
    expect(box.height).toBeGreaterThan(0)
    // 88 is CHROME_HEIGHT: everything below it belongs to the page view.
    expect(box.bottom).toBeLessThanOrEqual(88)
  })

  it('shows while a page is loading and clears once it lands', async () => {
    await resetToOneTab()
    await barSettles()

    await omnibox(`${fixtures.url}/slow-page`)

    // The bar should be up well before the page arrives.
    const deadline = Date.now() + SLOW_PAGE_MS
    let sawBar = false
    while (Date.now() < deadline && !sawBar) {
      sawBar = await progressOn()
      if (!sawBar) await new Promise((resolve) => setTimeout(resolve, 40))
    }
    expect(sawBar, 'the bar should appear while the page is still loading').toBe(true)

    await until((s) => activeTab(s).url.endsWith('/slow-page'), 'the slow page to arrive')
    await barSettles()
  })
})

describe('tabs', () => {
  it('opens a new tab from the menu accelerator and makes it active', async () => {
    await resetToOneTab()
    await menu('new-tab')
    const snap = await until((s) => s.tabs.length === 2, 'a second tab')
    expect(snap.activeTabId).toBe(snap.tabs[1]!.id)
    expect(await chrome.locator('.tab').count()).toBe(2)
  })

  it('shows only the active tab, and gives it the whole content area', async () => {
    await resetToOneTab()
    await menu('new-tab')
    const snap = await until((s) => s.tabs.length === 2, 'a second tab')
    const visible = snap.tabs.filter((t) => t.visible)
    expect(visible).toHaveLength(1)
    expect(visible[0]!.id).toBe(snap.activeTabId)
  })

  // The regression this test exists for: picking the last key in the map
  // means closing a middle tab throws you to the far right of the strip.
  it('activates the neighbour when the active tab is closed, not the far end', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await menu('new-tab')
    let snap = await until((s) => s.tabs.length === 3, 'three tabs')
    const [first, middle, last] = snap.tabs as [TabInfo, TabInfo, TabInfo]

    await chrome.evaluate((id) => window.troy.selectTab(id), middle.id)
    await until((s) => s.activeTabId === middle.id, 'the middle tab to be active')

    await chrome.evaluate((id) => window.troy.closeTab(id), middle.id)
    snap = await until((s) => s.tabs.length === 2, 'the middle tab to close')
    expect(snap.activeTabId).toBe(last.id)
    expect(snap.tabs.map((t) => t.id)).toEqual([first.id, last.id])
  })

  it('opens a fresh tab rather than leaving an empty window when the last tab closes', async () => {
    await resetToOneTab()
    const before = await snapshot()
    await chrome.evaluate((id) => window.troy.closeTab(id), before.tabs[0]!.id)
    const snap = await until(
      (s) => s.tabs[0]!.id !== before.tabs[0]!.id && s.tabs[0]!.url.includes('newtab.html'),
      'a replacement tab showing the new tab page',
    )
    expect(snap.tabs).toHaveLength(1)
    expect(activeTab(snap).id).toBe(snap.tabs[0]!.id)
  })

  it('turns a page calling window.open into a tab, never an uncontrolled popup', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/popup.html`)
    await until((s) => activeTab(s).url.endsWith('/popup.html'), 'the popup fixture to load')

    // Playwright counts every tab's webContents as a "window", so the thing
    // that would actually be a popup has to be counted in the main process.
    const realWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const windowsBefore = await realWindows()
    await app.evaluate(({ webContents }, target) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === target)
      page?.executeJavaScript('document.getElementById("open").click()', true)
    }, `${fixtures.url}/popup.html`)

    const snap = await until(
      (s) => s.tabs.some((t) => t.url.endsWith('/article.html')),
      'window.open to become a tab',
    )
    expect(snap.tabs).toHaveLength(2)
    expect(await realWindows()).toBe(windowsBefore)
  })
})

describe('the tab strip', () => {
  const widths = () =>
    chrome.evaluate(() =>
      [...document.querySelectorAll('.tab')].map((t) => Math.round(t.getBoundingClientRect().width)),
    )

  it('gives a tab a roomy width and shrinks them evenly once the strip fills', async () => {
    await resetToOneTab()
    expect((await widths())[0]).toBe(268)

    for (let i = 0; i < 13; i++) await menu('new-tab')
    await until((s) => s.tabs.length === 14, 'a full strip')

    const crowded = await widths()
    expect(crowded).toHaveLength(14)
    expect(crowded.every((w) => w < 268)).toBe(true)
    expect(new Set(crowded).size).toBe(1) // shrunk evenly, not one runt at the end

    // Crowding must shrink tabs, never push the strip past the window.
    const overflows = await chrome.evaluate(() => {
      const strip = document.querySelector('.tabstrip')!
      return strip.scrollWidth > strip.clientWidth + 1
    })
    expect(overflows).toBe(false)
  })

  it('centres the close icon in its button, and draws it big enough to see', async () => {
    await resetToOneTab()
    const geometry = await chrome.evaluate(() => {
      const button = document.querySelector('.tab .x')!.getBoundingClientRect()
      const icon = document.querySelector('.tab .x svg')!.getBoundingClientRect()
      return {
        vertical: Math.abs(icon.top + icon.height / 2 - (button.top + button.height / 2)),
        horizontal: Math.abs(icon.left + icon.width / 2 - (button.left + button.width / 2)),
        ratio: icon.width / button.width,
      }
    })
    expect(geometry.vertical).toBeLessThan(0.5)
    expect(geometry.horizontal).toBeLessThan(0.5)
    // Centred but tiny still reads as broken. The cross should fill a good
    // half of its button, the way every other browser draws one.
    expect(geometry.ratio).toBeGreaterThan(0.5)
  })

  it('keeps the same element for a tab across updates, so favicons do not refetch', async () => {
    await resetToOneTab()
    await chrome.evaluate(() => {
      document.querySelector('.tab')!.setAttribute('data-witness', 'original')
    })

    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).title.includes('article'), 'a navigation with several state updates')

    // A rebuild would have thrown this element away and with it the favicon
    // image, which is what made tabs flicker while a page loaded.
    expect(await chrome.getAttribute('.tab', 'data-witness')).toBe('original')
  })

  it('hides a favicon that fails to load instead of showing a broken image', async () => {
    await resetToOneTab()
    // The fixture server answers /favicon.ico with its 404 page, which an
    // <img> cannot decode, so this is the no-icon case every plain site hits.
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).title.includes('article'), 'the article')

    const visible = await chrome.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const img = document.querySelector('.tab .fav')
      return img ? !img.hidden : false
    })
    expect(visible).toBe(false)
  })
})

describe('failures', () => {
  it('shows a failure page, keeps the address you asked for, and retries it on reload', async () => {
    await resetToOneTab()
    // Port 1 on loopback refuses instantly, so this is a deterministic
    // failure rather than a DNS lookup that some networks answer anyway.
    await omnibox(deadUrl)

    const snap = await until(
      (s) => activeTab(s).failed !== null && activeTab(s).url.includes('error.html'),
      'the failure page',
    )
    const tab = activeTab(snap)
    expect(tab.url).toContain('error.html')
    expect(tab.displayUrl).toBe(deadUrl)
    expect(tab.failed?.reason).toMatch(/refused|reached/i)

    // the omnibox shows what was asked for, not Troy's internal error page
    expect(await chrome.inputValue('#omni')).toBe(deadUrl)
    expect(await chrome.locator('.tab.active .label').textContent()).toBe('Did not load')

  })

  it('reloading a failure page retries the address that failed, not the failure page', async () => {
    await resetToOneTab()
    // Nothing is listening yet, so this refuses. Chromium does not silently
    // retry a refused connection the way it retries a dropped one, which is
    // what makes this deterministic.
    const port = await findClosedPort()
    const target = `http://127.0.0.1:${port}/`
    await omnibox(target)
    await until(
      (s) => activeTab(s).failed !== null && activeTab(s).url.includes('error.html'),
      'the first attempt to fail',
    )

    // Now bring a server up on that exact port. Recovery is only possible if
    // reload goes back to the address that failed.
    const recovered = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Troy fixture: recovered</title><h1>Recovered</h1>')
    })
    await new Promise<void>((resolve) => recovered.listen(port, '127.0.0.1', () => resolve()))

    try {
      await menu('reload')
      // Wait for the title too, not just the address. A committed navigation
      // does not mean page-title-updated has fired yet, and until then the
      // strip shows the host as a placeholder.
      const snap = await until(
        (s) => activeTab(s).url === target && activeTab(s).title.includes('recovered'),
        'the retry to reach the original address and render it',
      )
      expect(activeTab(snap).failed).toBeNull()
    } finally {
      recovered.closeAllConnections()
      await new Promise<void>((resolve) => recovered.close(() => resolve()))
    }
  })

  // Regression: a failure that arrives after you have moved on used to
  // replace the page you asked for with an error page about the old address.
  it('drops a failure that arrives after you have already asked for somewhere else', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/slow-fail`)
    await omnibox(`${fixtures.url}/article.html`)

    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the good page to load')
    // Well past the point where the dropped connection reports back.
    await new Promise((resolve) => setTimeout(resolve, SLOW_FAIL_MS * 4))

    const snap = await snapshot()
    expect(activeTab(snap).url).toBe(`${fixtures.url}/article.html`)
    expect(activeTab(snap).failed).toBeNull()
  })

  it('clears the failure once a real page loads in that tab', async () => {
    await resetToOneTab()
    await omnibox(deadUrl)
    await until((s) => activeTab(s).failed !== null, 'the failure page')

    await omnibox(`${fixtures.url}/article.html`)
    const snap = await until((s) => activeTab(s).failed === null, 'the failure to clear')
    expect(activeTab(snap).url).toBe(`${fixtures.url}/article.html`)
  })
})

describe('staying open', () => {
  // The reported crash: "Troy quit unexpectedly". An uncaught exception in
  // the main process takes the whole browser with it, every tab and every
  // signed-in session, and reports itself only as EXC_BREAKPOINT. One bad
  // handler is not a reason to lose the window.
  it('survives an uncaught exception in the main process', async () => {
    await resetToOneTab()
    const before = await snapshot()

    await app.evaluate(() => {
      setTimeout(() => {
        throw new Error('a handler threw, as handlers eventually do')
      }, 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 600))

    // Still here, still answering, still holding the same tab.
    const after = await snapshot()
    expect(after.tabs).toHaveLength(before.tabs.length)
    expect(after.activeTabId).toBe(before.activeTabId)

    // And still usable, not merely alive.
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the browser to still navigate')
  })

  it('survives an unhandled promise rejection too', async () => {
    await resetToOneTab()
    await app.evaluate(() => {
      void Promise.reject(new Error('nobody caught this'))
    })
    await new Promise((resolve) => setTimeout(resolve, 600))

    await omnibox(`${fixtures.url}/popup.html`)
    await until((s) => activeTab(s).url.endsWith('/popup.html'), 'the browser to still navigate')
  })

  it('writes what went wrong to a log rather than swallowing it', async () => {
    await app.evaluate(() => {
      setTimeout(() => {
        throw new Error('recorded-for-the-log')
      }, 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 600))

    const log = path.join(userDataDir, 'troy-errors.log')
    const contents = await readFile(log, 'utf8').catch(() => '')
    expect(contents).toContain('recorded-for-the-log')
  })
})

describe('the agent panel', () => {
  it('shrinks the page rather than covering it when the panel opens', async () => {
    await resetToOneTab()
    const before = await snapshot()
    const fullWidth = activeTab(before).bounds.width

    await menu('toggle-panel')
    const open = await until((s) => s.panelOpen, 'the panel to open')
    expect(activeTab(open).bounds.width).toBeLessThan(fullWidth)
    expect(await chrome.locator('#agentpanel').isVisible()).toBe(true)

    await menu('toggle-panel')
    const closed = await until((s) => !s.panelOpen, 'the panel to close')
    expect(activeTab(closed).bounds.width).toBe(fullWidth)
  })

  it('reads the live tab over CDP and leaves no debugger attached behind it', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).title.includes('article'), 'the article to load')

    const result = (await chrome.evaluate(() => window.troy.read())) as {
      url?: string
      title?: string
      blockCount?: number
      domBlockCount?: number
      characterCount?: number
      markdown?: string
      error?: string
    }
    expect(result.error).toBeUndefined()
    expect(result.url).toBe(`${fixtures.url}/article.html`)
    expect(result.title).toContain('article')
    expect(result.blockCount ?? 0).toBeGreaterThan(0)
    expect(result.domBlockCount ?? 0).toBeGreaterThan(0)
    expect(result.characterCount ?? 0).toBeGreaterThan(0)
    expect(result.markdown).toContain('Vellichor Migration')

    // A debugger left attached locks DevTools out of that tab permanently.
    const stillAttached = await app.evaluate(({ webContents }, target) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL() === target)
      return page ? page.debugger.isAttached() : null
    }, `${fixtures.url}/article.html`)
    expect(stillAttached).toBe(false)
  })
})

describe('history', () => {
  it('goes back and forward through the menu', async () => {
    await resetToOneTab()
    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the article')
    await omnibox(`${fixtures.url}/popup.html`)
    await until((s) => activeTab(s).url.endsWith('/popup.html'), 'the popup fixture')

    await menu('back')
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'going back')

    await menu('forward')
    await until((s) => activeTab(s).url.endsWith('/popup.html'), 'going forward')
  })

  it('records visits when rememberHistory is on and clears them when it is turned off', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a new tab page')

    await app.evaluate(
      ({ webContents }, enabled) => {
        const page = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'))
        if (!page) throw new Error('no new tab page open')
        return page.executeJavaScript(
          `window.troyNewTab.setSetting('rememberHistory', ${JSON.stringify(enabled)})`,
          true,
        )
      },
      true,
    )

    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the article')

    const { existsSync } = await import('node:fs')
    const historyPath = `${userDataDir}/history.json`
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !existsSync(historyPath)) {
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    expect(existsSync(historyPath)).toBe(true)

    const raw = await (await import('node:fs/promises')).readFile(historyPath, 'utf8')
    const entries = JSON.parse(raw) as Array<{ url: string }>
    expect(entries.some((entry) => entry.url === `${fixtures.url}/article.html`)).toBe(true)

    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a fresh new tab page to turn history off')
    await app.evaluate(({ webContents }) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'))
      return page?.executeJavaScript(`window.troyNewTab.setSetting('rememberHistory', false)`, true)
    })

    expect(existsSync(historyPath)).toBe(false)
  })

  it('does not record visits while rememberHistory stays off', async () => {
    await resetToOneTab()
    await menu('new-tab')
    await until((s) => activeTab(s).url.includes('newtab.html'), 'a new tab page')
    await app.evaluate(({ webContents }) => {
      const page = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'))
      return page?.executeJavaScript(`window.troyNewTab.setSetting('rememberHistory', false)`, true)
    })

    await omnibox(`${fixtures.url}/article.html`)
    await until((s) => activeTab(s).url.endsWith('/article.html'), 'the article')

    const { existsSync } = await import('node:fs')
    expect(existsSync(`${userDataDir}/history.json`)).toBe(false)
  })
})
