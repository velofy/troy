// Troy's browser window: a real Chromium tab under our own chrome.
//
// The chrome (tab strip, omnibox, nav buttons, agent panel) is an ordinary
// web page in the window's own webContents. Each tab is a WebContentsView
// laid out below the chrome, so page content renders exactly as Chrome
// renders it and cannot repaint or script our UI.
//
// Every tab's webContents.debugger speaks CDP, which is the same protocol
// the engine already drives through the Cdp port. That is what lets the
// read pipeline run against the tab you are looking at, unchanged.

import { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, nativeImage, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveOmnibox, ENGINES } from './omnibox.js'
import { installSafetyNet } from './resilience.js'
import { installBlocker } from './tracking.js'
import { settingsFile, readSettings, writeSettings } from './settings.js'
import { shortcutsFile, readShortcuts, addShortcut, removeShortcut } from './shortcuts.js'
import { loadExtensions, summarise } from './extensions.js'
import { describeEndpoint, endpointFile, writeEndpoint, clearEndpoint } from './endpoint.js'
import { readTab, summariseDocument } from './readPort.js'
import { historyFile, recordVisit, clearHistory } from './history.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(dir, '..', '..')

const CHROME_HEIGHT = 88 // tab strip plus toolbar, matched in chrome.css
const PANEL_WIDTH = 340 // agent panel, when open
const MIN_WIDTH = 520
const MIN_HEIGHT = 400

/**
 * @typedef {object} Tab
 * @property {number} id
 * @property {import('electron').WebContentsView} view
 * @property {string | null} favicon
 * @property {{ url: string, reason: string } | null} failed
 * @property {string | null} pending
 *   The address this tab was most recently asked to show. A failure that
 *   arrives for anything else is stale and must be dropped, see showFailure.
 */

/** @type {BrowserWindow | null} */
let win = null
/** @type {Map<number, Tab>} */
const tabs = new Map()
let nextTabId = 1
let activeTabId = 0
let panelOpen = false

const NEW_TAB_URL = pageUrl('newtab.html')
const ERROR_PAGE = pageUrl('error.html')

/**
 * The URL of one of Troy's own pages.
 *
 * Built with pathToFileURL rather than by gluing "file://" onto a path,
 * because on Windows that glue produces "file://D:\...\newtab.html" while
 * Chromium reports "file:///D:/.../newtab.html". Every prefix comparison
 * against it then silently fails, which showed up as the new tab page
 * leaking its own file path into the address bar and as the failure page
 * not being recognised as the failure page.
 *
 * @param {string} file
 * @returns {string}
 */
function pageUrl(file) {
  return pathToFileURL(path.join(dir, 'renderer', file)).href
}

// Troy, not Electron, in the Dock, the menu bar and the userData path. Set
// before app ready because getPath('userData') is derived from the name.
app.setName('Troy')

/**
 * Attaching a debugger from outside is how another process drives this
 * browser. It is off unless asked for, because an open CDP port is full
 * control of every logged-in tab.
 */
const cdpPort = readCdpPort()
if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1')
}

/**
 * A tab is only safe to touch while its renderer exists. Once a webContents
 * is destroyed, every getter on it throws, and a throw from an event handler
 * in the main process ends the whole browser.
 *
 * @param {Tab | undefined} tab
 * @returns {tab is Tab}
 */
function alive(tab) {
  if (!tab) return false
  try {
    return !tab.view.webContents.isDestroyed()
  } catch {
    return false
  }
}

/** Forget tabs whose renderer has gone, so nothing reaches for them again. */
function pruneDeadTabs() {
  for (const [id, tab] of tabs) {
    if (!alive(tab)) tabs.delete(id)
  }
}

/** @returns {number | null} */
function readCdpPort() {
  const flag = process.argv.find((a) => a.startsWith('--cdp-port='))
  const raw = flag ? flag.slice('--cdp-port='.length) : process.env.TROY_CDP_PORT
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

// ---------------------------------------------------------------- layout

function layoutActive() {
  if (!win || win.isDestroyed()) return
  const tab = tabs.get(activeTabId)
  if (!alive(tab)) return
  const { width, height } = win.getContentBounds()
  const right = panelOpen ? Math.min(PANEL_WIDTH, Math.max(0, width - 320)) : 0
  tab.view.setBounds({
    x: 0,
    y: CHROME_HEIGHT,
    width: Math.max(0, width - right),
    height: Math.max(0, height - CHROME_HEIGHT),
  })
}

/**
 * What the omnibox should show for a tab. A tab showing the failure page
 * displays the address that failed, not the address of the failure page,
 * because the second one is Troy's business and not the user's.
 *
 * @param {Tab} tab
 * @returns {string}
 */
function displayUrl(tab) {
  if (tab.failed) return tab.failed.url
  if (!alive(tab)) return ''
  const url = tab.view.webContents.getURL()
  return url.startsWith(NEW_TAB_URL) ? '' : url
}

let syncQueued = false

/**
 * Tell the chrome what every tab looks like now.
 *
 * Coalesced to once per turn of the loop. A single navigation fires
 * did-start-loading, did-navigate, page-title-updated, page-favicon-updated
 * and did-stop-loading in a burst, and sending five near-identical states
 * across the process boundary makes the chrome do five times the work for
 * one visible change.
 */
function syncChrome() {
  if (syncQueued) return
  syncQueued = true
  setImmediate(sendChromeState)
}

function sendChromeState() {
  syncQueued = false
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  // A tab can die between the state being queued and this running, and every
  // getter on a dead webContents throws. Drop them first, then read.
  pruneDeadTabs()
  const list = [...tabs.values()].map((tab) => ({
    id: tab.id,
    title: tabTitle(tab),
    url: displayUrl(tab),
    favicon: tab.favicon,
    failed: Boolean(tab.failed),
    // Per tab, not just the active one, so a background tab still working
    // shows it in the strip rather than looking finished.
    loading: alive(tab) ? tab.view.webContents.isLoading() : false,
    active: tab.id === activeTabId,
  }))
  const active = tabs.get(activeTabId)
  const usable = alive(active)
  win.webContents.send('tabs:changed', {
    tabs: list,
    canGoBack: usable ? active.view.webContents.navigationHistory.canGoBack() : false,
    canGoForward: usable ? active.view.webContents.navigationHistory.canGoForward() : false,
    loading: usable ? active.view.webContents.isLoading() : false,
    panelOpen,
  })
}

/**
 * @param {Tab} tab
 * @returns {string}
 */
function tabTitle(tab) {
  if (tab.failed) return 'Did not load'
  if (!alive(tab)) return 'Closing'
  const url = tab.view.webContents.getURL()
  if (!url || url.startsWith(NEW_TAB_URL)) return 'New Tab'
  return tab.view.webContents.getTitle() || hostOf(url) || 'Untitled'
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ tabs

/**
 * @param {string} [url]
 * @returns {number}
 */
function createTab(url = NEW_TAB_URL) {
  if (!win || win.isDestroyed()) return 0
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Exposes nothing unless the document is Troy's own new tab page. See
      // tab-preload.cjs for why that check is sound.
      preload: path.join(dir, 'tab-preload.cjs'),
    },
  })
  const id = nextTabId++
  /** @type {Tab} */
  const tab = { id, view, favicon: null, failed: null, pending: null }
  tabs.set(id, tab)
  win.contentView.addChildView(view)

  const wc = view.webContents
  wc.setVisualZoomLevelLimits(1, 3).catch(() => {})

  for (const event of ['page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(/** @type {'did-stop-loading'} */ (event), syncChrome)
  }

  wc.on('did-navigate', (_event, navigatedTo) => {
    // Chromium lands here after a blocked location.href assignment. Go back
    // rather than leaving the tab on an empty placeholder page.
    if (navigatedTo === 'about:blank#blocked' && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
      return
    }
    if (!navigatedTo.startsWith(ERROR_PAGE)) {
      tab.failed = null
      tab.favicon = null
    }
    // What committed is now what this tab is showing, so a failure report
    // for some earlier address is out of date by definition.
    tab.pending = navigatedTo
    syncChrome()
    maybeRecordHistory(tab, navigatedTo)
  })

  // A redirect changes what "the address we asked for" means, so the
  // staleness check has to follow it. Without this, a page that redirects and
  // then fails at its destination would show no failure at all.
  wc.on('did-redirect-navigation', (_details, redirectedTo, _isInPlace, isMainFrame) => {
    if (isMainFrame) tab.pending = redirectedTo
  })
  wc.on('did-navigate-in-page', (_event, navigatedTo, isMainFrame) => {
    if (isMainFrame) {
      tab.pending = navigatedTo
      syncChrome()
    }
  })

  wc.on('did-stop-loading', () => {
    maybeRecordHistory(tab)
  })

  wc.on('page-favicon-updated', (_event, icons) => {
    tab.favicon = icons[0] ?? null
    syncChrome()
  })

  // A failed main-frame load leaves Chromium showing nothing at all, which
  // reads as a hung browser. ERR_ABORTED (-3) is not a failure: it is what a
  // redirect, a download, or the user typing a new address looks like.
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    showFailure(tab, validatedURL || displayUrl(tab), describeLoadError(errorCode, errorDescription))
  })

  // A tab whose renderer died stays blank and unresponsive forever unless
  // something notices. Reloading a crashed tab is what Chrome does too.
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    showFailure(tab, displayUrl(tab), `The page stopped responding (${details.reason}).`, true)
  })

  // A page asking for a new window gets a new tab, never a popup we do not
  // control, and an external protocol goes to the OS rather than nowhere.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      selectTab(createTab(target))
    } else if (target && target !== 'about:blank') {
      shell.openExternal(target).catch(() => {})
    }
    return { action: 'deny' }
  })

  // The same refusal the omnibox makes, applied to the page's own attempts
  // to move the top-level frame somewhere Troy will not go.
  wc.on('will-navigate', (event, target) => {
    // The new tab page's search box is a plain GET form, so a submit arrives
    // here as a navigation to newtab.html?q=... Cancel it and hand the text
    // to the same resolver the address bar uses, so both boxes refuse the
    // same things without the page needing any privilege of its own.
    const query = newTabQuery(target)
    if (query !== null) {
      event.preventDefault()
      const result = navigate(query, tab)
      if (result.kind === 'refused') notify(`Troy will not open that: ${result.reason ?? ''}`)
      return
    }
    if (!isNavigableUrl(target)) {
      event.preventDefault()
      shell.openExternal(target).catch(() => {})
      return
    }
    tab.pending = target
  })

  void loadInTab(tab, url)
  return id
}

/**
 * @param {Tab} tab
 * @param {string} url
 */
async function loadInTab(tab, url) {
  tab.pending = url
  try {
    await tab.view.webContents.loadURL(url)
  } catch (err) {
    // loadURL rejects on the same conditions did-fail-load reports, and an
    // unhandled rejection here would take down the main process.
    const code = /** @type {{ errno?: number }} */ (err)?.errno
    if (code === -3) return
    showFailure(tab, url, describeLoadError(code ?? 0, String(err)))
  }
}

/**
 * Put the failure page in a tab.
 *
 * A failure can arrive after the user has already asked for somewhere else:
 * type a dead address, then immediately type a good one, and the refused
 * connection comes back while the good page is loading or already up. Showing
 * it then would throw away the page they asked for. So unless the failure is
 * for what this tab is currently trying to show, it is dropped.
 *
 * `force` is for a dead renderer, which is a failure of whatever is on screen
 * rather than of a particular address.
 *
 * @param {Tab} tab
 * @param {string} url
 * @param {string} reason
 * @param {boolean} [force]
 */
function showFailure(tab, url, reason, force = false) {
  if (!force && tab.pending !== null && tab.pending !== url) return
  tab.failed = { url, reason }
  tab.favicon = null
  const target = `${ERROR_PAGE}?u=${encodeURIComponent(url)}&r=${encodeURIComponent(reason)}`
  tab.view.webContents.loadURL(target).catch(() => {})
  syncChrome()
}

/**
 * Chromium's net error codes, in the words someone reading them would use.
 *
 * @param {number} code
 * @param {string} description
 * @returns {string}
 */
function describeLoadError(code, description) {
  switch (code) {
    case -105:
      return 'That address has no server behind it. Check the spelling.'
    case -106:
      return 'This machine appears to be offline.'
    case -102:
      return 'The server refused the connection.'
    case -7:
    case -118:
      return 'The server took too long to answer.'
    case -200:
    case -201:
    case -202:
      return 'The security certificate for that site is not valid.'
    case -137:
      return 'That host could not be resolved.'
    default:
      return humanise(description)
  }
}

/**
 * Chromium hands back tokens like ERR_UNSAFE_PORT. Printed as-is they read
 * as a leaked internal, so unknown codes become a sentence with the token
 * kept in parentheses, which is still searchable.
 *
 * @param {string} description
 * @returns {string}
 */
function humanise(description) {
  const token = /^ERR_[A-Z0-9_]+$/.test(description ?? '')
  if (token) {
    const words = description.slice(4).toLowerCase().replace(/_/g, ' ')
    return `The page could not be reached: ${words} (${description}).`
  }
  return description ? `${description}.` : 'The page could not be reached.'
}

/**
 * The text submitted from the new tab page's search box, or null if this is
 * not that navigation.
 *
 * @param {string} target
 * @returns {string | null}
 */
function newTabQuery(target) {
  if (!target.startsWith(`${NEW_TAB_URL}?`)) return null
  try {
    return new URL(target).searchParams.get('q') ?? ''
  } catch {
    return ''
  }
}

/**
 * Say something in the chrome, as a whole sentence. Used for anything the
 * user should see that did not come back from an ipc call they made, such as
 * a refusal from the new tab page or the result of reloading extensions.
 *
 * @param {string} message
 */
function notify(message) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('chrome:notice', message)
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isNavigableUrl(url) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'file') return true
  // Same rule as the omnibox: about:blank is a blank canvas, everything
  // else is browser internals a page must not steer you toward.
  if (scheme === 'about') return url.toLowerCase() === 'about:blank'
  return false
}

/** @param {number} id */
function selectTab(id) {
  pruneDeadTabs()
  const tab = tabs.get(id)
  if (!alive(tab)) return
  for (const [otherId, other] of tabs) {
    try {
      other.view.setVisible(otherId === id)
    } catch {
      // A view torn down mid-switch; pruneDeadTabs will collect it.
    }
  }
  activeTabId = id
  layoutActive()
  syncChrome()
  tab.view.webContents.focus()
}

/**
 * Closing a tab hands focus to its neighbour, the way every browser does.
 * Jumping to the far right of the strip because that key happened to be last
 * in the map is the kind of small wrongness that makes an app feel broken.
 *
 * @param {number} id
 */
function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab || !win) return
  const order = [...tabs.keys()]
  const index = order.indexOf(id)

  tabs.delete(id)
  try {
    win.contentView.removeChildView(tab.view)
  } catch {
    // The view may already be gone; pruneDeadTabs will forget the tab.
  }
  if (alive(tab)) tab.view.webContents.close()

  if (activeTabId !== id) {
    syncChrome()
    return
  }
  const remaining = [...tabs.keys()]
  if (remaining.length === 0) {
    selectTab(createTab())
    return
  }
  selectTab(remaining[Math.min(index, remaining.length - 1)] ?? remaining[0])
}

/** @returns {import('electron').WebContents | null} */
function activeContents() {
  const tab = tabs.get(activeTabId)
  if (!alive(tab)) return null
  return tab.view.webContents
}

// ------------------------------------------------------------- navigation

/**
 * @param {string} input
 * @param {Tab} [into] the tab to navigate, defaulting to the active one
 * @returns {{ kind: string, reason?: string }}
 */
function navigate(input, into) {
  const engine = ENGINES[/** @type {keyof typeof ENGINES} */ (settings().searchEngine)] ?? ENGINES.google
  const result = resolveOmnibox(input, { search: engine })
  const tab = into ?? tabs.get(activeTabId)
  if (!tab) return { kind: 'empty' }

  if (result.kind === 'url' || result.kind === 'search') {
    void loadInTab(tab, /** @type {string} */ (result.url))
  } else if (result.kind === 'external') {
    shell.openExternal(/** @type {string} */ (result.url)).catch(() => {})
  }
  return { kind: result.kind, reason: result.reason }
}

function goBack() {
  const wc = activeContents()
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

function goForward() {
  const wc = activeContents()
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

/** Reloading the failure page retries the address that failed, not the page. */
function reload() {
  const tab = tabs.get(activeTabId)
  if (!tab) return
  if (tab.failed) void loadInTab(tab, tab.failed.url)
  else tab.view.webContents.reload()
}

function togglePanel() {
  panelOpen = !panelOpen
  layoutActive()
  syncChrome()
  return panelOpen
}

// ------------------------------------------------------------ window state

/** @returns {string} */
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

/** @returns {{ width: number, height: number, x?: number, y?: number }} */
function readWindowState() {
  const fallback = { width: 1280, height: 860 }
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback
    const state = {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
    }
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { ...state, x: Math.round(raw.x), y: Math.round(raw.y) }
    }
    return state
  } catch {
    return fallback
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()))
  } catch {
    // A browser that cannot remember its size is still a browser.
  }
}

// ----------------------------------------------------------------- window

function createWindow() {
  const state = readWindowState()
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    ...state,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // On macOS the chrome is a vibrant surface: the system blurs whatever is
    // behind the window and Troy tints it, which is why the background has
    // to be clear rather than a colour. Everywhere else it stays a solid
    // panel, because faking vibrancy with a flat translucent fill over an
    // opaque window just looks washed out.
    ...(isMac ? { vibrancy: 'header', backgroundColor: '#00000000' } : { backgroundColor: '#202124' }),
    title: 'Troy',
    icon: appIcon() ?? undefined,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(dir, 'renderer', 'chrome.html'))
  for (const event of ['resize', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) {
    win.on(/** @type {'resize'} */ (event), layoutActive)
  }
  win.on('resize', saveWindowState)
  win.on('move', saveWindowState)
  win.on('close', saveWindowState)
  win.webContents.once('did-finish-load', () => {
    selectTab(createTab(firstUrlFromArgv()))
  })
  win.on('closed', () => {
    win = null
    tabs.clear()
    activeTabId = 0
  })
}

/** A URL passed on the command line opens instead of the new tab page. */
function firstUrlFromArgv() {
  const arg = process.argv.slice(1).find((a) => /^https?:\/\//i.test(a))
  return arg ?? undefined
}

/** @returns {import('electron').NativeImage | null} */
function appIcon() {
  const file = path.join(repoRoot, 'build', 'icon.png')
  if (!fs.existsSync(file)) return null
  const image = nativeImage.createFromPath(file)
  return image.isEmpty() ? null : image
}

// ------------------------------------------------------------------- menu

/**
 * Real accelerators, not a keydown listener in the chrome page. The chrome
 * only has keyboard focus until you click into a page, and after that a
 * renderer-side shortcut is dead: Cmd+T would stop opening tabs the moment
 * you started actually browsing.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: 'Troy',
            submenu: [
              { role: /** @type {const} */ ('about') },
              { type: /** @type {const} */ ('separator') },
              { role: /** @type {const} */ ('services') },
              { type: /** @type {const} */ ('separator') },
              { role: /** @type {const} */ ('hide') },
              { role: /** @type {const} */ ('hideOthers') },
              { type: /** @type {const} */ ('separator') },
              { role: /** @type {const} */ ('quit') },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { id: 'new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => selectTab(createTab()) },
        {
          id: 'close-tab',
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (activeTabId) closeTab(activeTabId)
          },
        },
        { type: /** @type {const} */ ('separator') },
        isMac ? { role: /** @type {const} */ ('close') } : { role: /** @type {const} */ ('quit') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: /** @type {const} */ ('undo') },
        { role: /** @type {const} */ ('redo') },
        { type: /** @type {const} */ ('separator') },
        { role: /** @type {const} */ ('cut') },
        { role: /** @type {const} */ ('copy') },
        { role: /** @type {const} */ ('paste') },
        { role: /** @type {const} */ ('selectAll') },
        { type: /** @type {const} */ ('separator') },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => win?.webContents.send('omni:focus'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reload },
        {
          id: 'toggle-panel',
          label: 'Toggle Agent Panel',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => {
            togglePanel()
          },
        },
        { type: /** @type {const} */ ('separator') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => setZoom(null, +0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom(null, -0.5) },
        { type: /** @type {const} */ ('separator') },
        {
          id: 'open-extensions',
          label: 'Extensions Folder',
          click: () => {
            fs.mkdirSync(extensionsDir(), { recursive: true })
            shell.openPath(extensionsDir()).catch(() => {})
          },
        },
        {
          id: 'reload-extensions',
          label: 'Reload Extensions',
          click: () => {
            void loadExtensions(session.defaultSession, extensionsDir()).then((results) => {
              notify(summarise(results))
            })
          },
        },
        { type: /** @type {const} */ ('separator') },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => activeContents()?.toggleDevTools(),
        },
        { role: /** @type {const} */ ('togglefullscreen') },
      ],
    },
    {
      label: 'History',
      submenu: [
        { id: 'back', label: 'Back', accelerator: 'CmdOrCtrl+[', click: goBack },
        { id: 'forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', click: goForward },
      ],
    },
    { role: /** @type {const} */ ('windowMenu') },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * @param {number | null} absolute
 * @param {number} [delta]
 */
function setZoom(absolute, delta = 0) {
  const wc = activeContents()
  if (!wc) return
  const next = absolute ?? wc.getZoomLevel() + delta
  wc.setZoomLevel(Math.max(-3, Math.min(4, next)))
}

// -------------------------------------------------------------------- ipc

ipcMain.handle('tab:new', (_e, url) => selectTab(createTab(typeof url === 'string' && url ? url : undefined)))
ipcMain.handle('tab:select', (_e, id) => selectTab(Number(id)))
ipcMain.handle('tab:close', (_e, id) => closeTab(Number(id)))
ipcMain.handle('nav:back', goBack)
ipcMain.handle('nav:forward', goForward)
ipcMain.handle('nav:reload', reload)
ipcMain.handle('nav:go', (_e, input) => navigate(String(input ?? '')))
ipcMain.handle('panel:toggle', togglePanel)

/**
 * Is this call coming from Troy's own new tab page.
 *
 * Checked here rather than trusted from the renderer. A preload can only
 * decide what to expose; the main process decides what to honour, and a page
 * cannot lie about the URL of the frame it is calling from.
 *
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function fromNewTab(event) {
  const url = event.senderFrame?.url ?? event.sender.getURL()
  return String(url).split('?')[0]?.split('#')[0] === NEW_TAB_URL
}

/**
 * Wrap an ipc handler so it only answers Troy's own new tab page.
 *
 * @param {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown} handler
 * @returns {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown}
 */
function newTabOnly(handler) {
  return (event, ...args) => {
    if (!fromNewTab(event)) throw new Error('this channel is for the new tab page')
    return handler(event, ...args)
  }
}

// The new tab page's surface, refused for every other page.
ipcMain.handle(
  'newtab:state',
  newTabOnly(() => {
    const dir = app.getPath('userData')
    const current = settings()
    return {
      shortcuts: readShortcuts(shortcutsFile(dir)),
      rememberHistory: current.rememberHistory,
      blockTrackers: current.blockTrackers,
    }
  }),
)

ipcMain.handle(
  'newtab:add',
  newTabOnly((_e, /** @type {{url?: unknown, title?: unknown}} */ entry) =>
    addShortcut(shortcutsFile(app.getPath('userData')), {
      url: String(entry?.url ?? ''),
      title: entry?.title ? String(entry.title) : undefined,
    }),
  ),
)

ipcMain.handle(
  'newtab:remove',
  newTabOnly((_e, /** @type {unknown} */ url) =>
    removeShortcut(shortcutsFile(app.getPath('userData')), String(url ?? '')),
  ),
)

ipcMain.handle(
  'newtab:setting',
  newTabOnly((_e, /** @type {{key?: unknown, value?: unknown}} */ change) => {
    const key = String(change?.key ?? '')
    if (key !== 'rememberHistory' && key !== 'blockTrackers') return settings()
    return updateSettings({ [key]: Boolean(change?.value) })
  }),
)

// A tile goes through the same resolver as the address bar, so a tile can
// never open something the address bar would refuse.
ipcMain.handle(
  'newtab:open',
  newTabOnly((_e, /** @type {unknown} */ url) => {
    const result = navigate(String(url ?? ''))
    if (result.kind === 'refused') notify(`Troy will not open that: ${result.reason ?? ''}`)
    return result.kind
  }),
)

// Reading the live tab. Returns structured page facts the agent panel and
// bridge can use before the full read pipeline lands. Attaches CDP briefly,
// the same way the Cdp port does, and always detaches so DevTools stay usable.
// Reading the live tab through the real pipeline: settle, extract, cover,
// transcribe, fuse. The heavy lifting lives in src/read and the tab adapter
// in readPort.js; this handler stays thin on purpose. Attaches CDP briefly,
// the same way the Cdp port does, and always detaches so DevTools stay usable.
ipcMain.handle('agent:read', async () => {
  const wc = activeContents()
  if (!wc) return { error: 'no active tab' }
  try {
    const doc = await readTab(wc)
    return summariseDocument(doc)
  } catch (err) {
    return { error: errorMessage(err) }
  }
})

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

// ------------------------------------------------------------------ start

/** Where unpacked extensions live, alongside the profile. */
function extensionsDir() {
  return path.join(app.getPath('userData'), 'extensions')
}

/** @type {import('./settings.js').Settings | null} */
let settingsCache = null

/**
 * Settings, held in memory.
 *
 * This is read on every network request, because the tracker blocker asks
 * whether it is enabled before deciding. Reading the file each time meant a
 * synchronous disk read per subresource, so a page pulling two hundred
 * requests did two hundred blocking reads on the main process and the whole
 * window stuttered. Nothing else writes this file, so a cache invalidated on
 * our own writes is exact.
 *
 * @returns {import('./settings.js').Settings}
 */
function settings() {
  if (!settingsCache) settingsCache = readSettings(settingsFile(app.getPath('userData')))
  return settingsCache
}

/**
 * @param {Partial<import('./settings.js').Settings>} patch
 * @returns {import('./settings.js').Settings}
 */
function updateSettings(patch) {
  const before = settings()
  settingsCache = writeSettings(settingsFile(app.getPath('userData')), patch)
  if (before.rememberHistory && !settingsCache.rememberHistory) {
    clearHistory(historyFile(app.getPath('userData')))
  }
  return settingsCache
}

/**
 * Record a finished load when the user asked Troy to remember where they went.
 *
 * @param {Tab} tab
 * @param {string} [urlOverride]
 */
function maybeRecordHistory(tab, urlOverride) {
  if (!settings().rememberHistory || !alive(tab) || tab.failed) return
  const wc = tab.view.webContents
  const url = urlOverride ?? wc.getURL()
  if (!url.startsWith('http://') && !url.startsWith('https://')) return
  if (url.startsWith(NEW_TAB_URL) || url.startsWith(ERROR_PAGE)) return
  recordVisit(historyFile(app.getPath('userData')), { url, title: wc.getTitle() || hostOf(url) })
}

app.whenReady().then(async () => {
  // Before anything else. An uncaught error in a handler used to end the
  // browser, tabs and all, and report itself only as "Troy quit unexpectedly".
  installSafetyNet({
    logFile: path.join(app.getPath('userData'), 'troy-errors.log'),
    onError: (scope, err) => {
      console.error(`[troy] ${scope}:`, err)
      notify('Something went wrong inside Troy. It stayed open; the details are in troy-errors.log.')
    },
  })

  // An agent browser should not hand out the camera because a page asked.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
  })

  // Cancel third-party analytics and ad beacons. The setting is read per
  // request rather than at startup, so the toggle takes effect at once.
  installBlocker(session.defaultSession, { enabled: () => settings().blockTrackers })

  fs.mkdirSync(extensionsDir(), { recursive: true })
  const loaded = await loadExtensions(session.defaultSession, extensionsDir())
  if (loaded.length) console.log(`[troy] ${summarise(loaded)}`)

  // Say where the agent bridge is, so nothing has to be copied by hand.
  if (cdpPort) {
    const file = endpointFile(app.getPath('userData'))
    writeEndpoint(file, describeEndpoint({ port: cdpPort, pid: process.pid, version: app.getVersion() }))
    app.on('will-quit', () => clearEndpoint(file))
  }

  if (process.platform === 'darwin' && app.dock) {
    const icon = appIcon()
    if (icon) app.dock.setIcon(icon)
  }

  buildMenu()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// A test hook, present only when a test asked for it. The battle tests need
// to see which tab is active and where each view actually sits, and neither
// is visible from the chrome page or from Electron's own API.
if (process.env.TROY_TEST === '1') {
  Object.assign(globalThis, {
    __troy: {
      snapshot: () => ({
        activeTabId,
        panelOpen,
        tabs: [...tabs.values()].map((tab) => ({
          id: tab.id,
          url: tab.view.webContents.getURL(),
          displayUrl: displayUrl(tab),
          title: tabTitle(tab),
          // What this tab was last asked to show, which is what a test wants
          // when it cares that a navigation was requested rather than that
          // some remote server answered.
          pending: tab.pending,
          failed: tab.failed,
          visible: tab.view.getVisible(),
          bounds: tab.view.getBounds(),
        })),
        contentBounds: win && !win.isDestroyed() ? win.getContentBounds() : null,
      }),
    },
  })
}

export { resolveOmnibox }
