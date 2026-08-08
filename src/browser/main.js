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
import { fileURLToPath } from 'node:url'
import { resolveOmnibox } from './omnibox.js'

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
 * @param {string} file
 * @returns {string}
 */
function pageUrl(file) {
  return `file://${path.join(dir, 'renderer', file)}`
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
  if (!tab) return
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
  const url = tab.view.webContents.getURL()
  return url.startsWith(NEW_TAB_URL) ? '' : url
}

/** Tell the chrome what every tab looks like now. */
function syncChrome() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const list = [...tabs.values()].map((tab) => ({
    id: tab.id,
    title: tabTitle(tab),
    url: displayUrl(tab),
    favicon: tab.favicon,
    failed: Boolean(tab.failed),
    active: tab.id === activeTabId,
  }))
  const active = tabs.get(activeTabId)
  win.webContents.send('tabs:changed', {
    tabs: list,
    canGoBack: active ? active.view.webContents.navigationHistory.canGoBack() : false,
    canGoForward: active ? active.view.webContents.navigationHistory.canGoForward() : false,
    loading: active ? active.view.webContents.isLoading() : false,
    panelOpen,
  })
}

/**
 * @param {Tab} tab
 * @returns {string}
 */
function tabTitle(tab) {
  if (tab.failed) return 'Did not load'
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
    if (!navigatedTo.startsWith(ERROR_PAGE)) {
      tab.failed = null
      tab.favicon = null
    }
    // What committed is now what this tab is showing, so a failure report
    // for some earlier address is out of date by definition.
    tab.pending = navigatedTo
    syncChrome()
  })

  // A redirect changes what "the address we asked for" means, so the
  // staleness check has to follow it. Without this, a page that redirects and
  // then fails at its destination would show no failure at all.
  wc.on('did-redirect-navigation', (_details, redirectedTo, _isInPlace, isMainFrame) => {
    if (isMainFrame) tab.pending = redirectedTo
  })
  wc.on('did-navigate-in-page', (_event, _navigatedTo, isMainFrame) => {
    if (isMainFrame) syncChrome()
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
 * @param {string} url
 * @returns {boolean}
 */
function isNavigableUrl(url) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return scheme === 'http' || scheme === 'https' || scheme === 'file' || scheme === 'about'
}

/** @param {number} id */
function selectTab(id) {
  const tab = tabs.get(id)
  if (!tab) return
  for (const [otherId, other] of tabs) other.view.setVisible(otherId === id)
  activeTabId = id
  layoutActive()
  syncChrome()
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
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
  win.contentView.removeChildView(tab.view)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()

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
  if (!tab || tab.view.webContents.isDestroyed()) return null
  return tab.view.webContents
}

// ------------------------------------------------------------- navigation

/**
 * @param {string} input
 * @returns {{ kind: string, reason?: string }}
 */
function navigate(input) {
  const result = resolveOmnibox(input)
  const tab = tabs.get(activeTabId)
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
  win = new BrowserWindow({
    ...state,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#202124',
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

// Reading the live tab. The engine lands here in the next step; today this
// proves the CDP attach path the whole design rests on, using the same
// protocol calls the Cdp port makes.
ipcMain.handle('agent:read', async () => {
  const wc = activeContents()
  if (!wc) return { error: 'no active tab' }
  let attachedHere = false
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      attachedHere = true
    }
    const { result } = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: 'document.title + "\\n" + document.body.innerText.slice(0, 4000)',
      returnByValue: true,
    })
    return { url: wc.getURL(), text: String(result.value ?? '') }
  } catch (err) {
    return { error: errorMessage(err) }
  } finally {
    // Leaving the debugger attached locks DevTools out of the tab for good.
    if (attachedHere && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // Already gone with the renderer; nothing to release.
      }
    }
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

app.whenReady().then(() => {
  // An agent browser should not hand out the camera because a page asked.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
  })

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
