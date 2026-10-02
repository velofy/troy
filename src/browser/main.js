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

import { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, nativeImage, session, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveOmnibox, ENGINES } from './omnibox.js'
import { installSafetyNet } from './resilience.js'
import { installBlocker } from './tracking.js'
import { settingsFile, readSettings, writeSettings } from './settings.js'
import { loadExtensions, summarise } from './extensions.js'
import { describeEndpoint, endpointFile, writeEndpoint, clearEndpoint } from './endpoint.js'
import { readTab, summariseDocument } from './readPort.js'
import { historyFile, readHistory, recordVisit, clearHistory } from './history.js'
import { bookmarksFile, readBookmarks, toggleBookmark, isBookmarked } from './bookmarks.js'
import { createCommandRegistry } from './commands.js'
import { buildPaletteResults } from './palette.js'
import { PROVIDERS, keysFile, setKey, getKey, keyStatus, clearKey } from '../agent/keys.js'
import { DEFAULT_MODELS } from '../agent/llm.js'
import { createAgentController } from './agentController.js'
import { whisperAssets } from '../voice/whisper.js'
import { transcribeLocalWav, MAX_VOICE_BYTES } from '../voice/transcribe.js'
import { createOcrEngine } from '../read/ocr-factory.js'

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
/** @type {import('electron').WebContentsView | null} */
let paletteView = null
let paletteOpen = false
let paletteQueryCounter = 0
/** @type {{ id: string, results: Map<string, any> } | null} */
let paletteQuery = null
/** @type {ReturnType<typeof createAgentController> | null} */
let agentController = null
let microphoneCaptureUntil = 0
let voiceShortcutDown = false
/** @type {AbortController | null} */
let voiceTranscription = null
/** @type {ReturnType<typeof createOcrEngine> | null} */
let ocrEngine = null

const CHROME_URL = pageUrl('chrome.html')
const PALETTE_URL = pageUrl('palette.html')
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

/**
 * Compare renderer documents without letting a query or fragment turn one
 * privileged local page into a second identity.
 *
 * @param {string} url
 * @returns {string}
 */
function documentUrl(url) {
  return String(url ?? '').split('#')[0].split('?')[0]
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
 * How the window comes up. The usual reason Troy is spawned from a script is
 * that an agent wants its debugging port, and a window that seizes focus in
 * the middle of someone's typing is a bug, not a feature. So a launch that
 * asks for the agent bridge (or passes --background) comes up inactive: the
 * window is on screen, but the app that had focus keeps it. --hidden goes one
 * step further and shows nothing until the app is activated. --foreground
 * opts back into ordinary behaviour.
 */
const launchMode = readLaunchMode()
if (launchMode === 'hidden') {
  // Hidden windows would otherwise have their rendering throttled, which
  // would quietly break the read pipeline's screenshots. Keep them painting.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
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

/** @returns {'foreground' | 'background' | 'hidden'} */
function readLaunchMode() {
  const args = process.argv
  if (args.includes('--foreground') || args.includes('--focus')) return 'foreground'
  if (args.includes('--hidden') || process.env.TROY_LAUNCH === 'hidden') return 'hidden'
  if (args.includes('--background') || args.includes('-g') || cdpPort || process.env.TROY_LAUNCH === 'background') {
    return 'background'
  }
  return 'foreground'
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
  layoutPalette()
}

function layoutPalette() {
  if (!win || win.isDestroyed() || !paletteView) return
  const { width, height } = win.getContentBounds()
  const right = panelOpen ? Math.min(PANEL_WIDTH, Math.max(0, width - 320)) : 0
  const availableWidth = Math.max(0, width - right)
  const paletteWidth = Math.max(300, Math.min(680, availableWidth - 32))
  const availableHeight = Math.max(0, height - CHROME_HEIGHT)
  const paletteHeight = Math.max(180, Math.min(460, availableHeight - 32))
  paletteView.setBounds({
    x: Math.max(0, Math.round((availableWidth - paletteWidth) / 2)),
    y: CHROME_HEIGHT + Math.max(12, Math.min(28, Math.round((availableHeight - paletteHeight) * 0.18))),
    width: paletteWidth,
    height: paletteHeight,
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
  installVoiceShortcut(wc)
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
    if (agentController?.boundary(id, target, 'the page tried to open an origin outside this agent session')) {
      return { action: 'deny' }
    }
    if (target.startsWith('http://') || target.startsWith('https://')) {
      selectTab(createTab(target))
    } else if (target && target !== 'about:blank' && agentController?.activeTabId !== id) {
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
    if (agentController?.boundary(id, target, 'navigation crossed this agent session origin boundary')) {
      event.preventDefault()
      return
    }
    if (!isNavigableUrl(target)) {
      event.preventDefault()
      if (agentController?.activeTabId !== id) shell.openExternal(target).catch(() => {})
      return
    }
    tab.pending = target
  })

  wc.on('will-redirect', (event, target, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    if (agentController?.boundary(id, target, 'a redirect crossed this agent session origin boundary')) {
      event.preventDefault()
    }
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
  agentController?.onTabChanged(id)
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
  agentController?.onTabClosed(id)
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

function keyCrypt() {
  const securelyAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true
    try {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    } catch {
      return false
    }
  }
  return {
    isEncryptionAvailable: securelyAvailable,
    encryptString: (/** @type {string} */ value) => safeStorage.encryptString(value),
    decryptString: (/** @type {Buffer} */ value) => safeStorage.decryptString(value),
  }
}

function selectedOcr() {
  if (!ocrEngine) {
    ocrEngine = createOcrEngine({
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
    })
  }
  return ocrEngine
}

function agents() {
  if (agentController) return agentController
  agentController = createAgentController({
    getActiveTab: () => {
      const tab = tabs.get(activeTabId)
      return alive(tab) ? { id: tab.id, webContents: tab.view.webContents } : null
    },
    getKey: (provider) => getKey(keysFile(app.getPath('userData')), keyCrypt(), provider),
    resolve: resolveNavigation,
    ocr: selectedOcr(),
    emit: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('agent:event', event)
    },
  })
  return agentController
}

function agentState() {
  const current = settings()
  return {
    provider: current.agentProvider,
    model: current.agentModel,
    defaults: { ...DEFAULT_MODELS },
    keys: storedKeyStatus(),
    session: agents().state(activeTabId),
  }
}

function localVoiceAssets() {
  return whisperAssets({ resourcesPath: process.resourcesPath, repoRoot, platform: process.platform, arch: process.arch })
}

function voiceState() {
  const assets = localVoiceAssets()
  return {
    available: assets.available,
    engine: assets.available ? 'whisper.cpp tiny multilingual' : 'none',
    offline: true,
    reason: assets.available ? '' : 'local whisper.cpp assets are not installed; typing remains available',
  }
}

/** @param {'press'|'release'|'cancel'} kind */
function sendVoiceShortcut(kind) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  if (kind === 'press' && !panelOpen) togglePanel()
  win.webContents.send(`voice:${kind}`)
}

/** @param {import('electron').WebContents} wc */
function installVoiceShortcut(wc) {
  wc.on('before-input-event', (event, input) => {
    const space = input.code === 'Space' || input.key === ' '
    const command = Boolean(input.meta || input.control)
    if (!space || !command || !input.shift || input.alt) return
    event.preventDefault()
    if (input.type === 'keyDown') {
      if (voiceShortcutDown || input.isAutoRepeat) return
      voiceShortcutDown = true
      sendVoiceShortcut('press')
    } else if (input.type === 'keyUp' && voiceShortcutDown) {
      voiceShortcutDown = false
      sendVoiceShortcut('release')
    }
  })
}

// ------------------------------------------------------------- navigation

/**
 * Resolve browser input through the one omnibox policy used by every entry
 * point. Keeping resolution separate lets a caller create a tab at the final
 * safe URL instead of briefly loading an unchecked renderer-supplied string.
 *
 * @param {string} input
 */
function resolveNavigation(input) {
  const engine = ENGINES[/** @type {keyof typeof ENGINES} */ (settings().searchEngine)] ?? ENGINES.google
  return resolveOmnibox(input, { search: engine })
}

/**
 * @param {string} input
 * @param {Tab} [into] the tab to navigate, defaulting to the active one
 * @returns {{ kind: string, reason?: string }}
 */
function navigate(input, into) {
  const result = resolveNavigation(input)
  const tab = into ?? tabs.get(activeTabId)
  if (!tab) return { kind: 'empty' }

  if (result.kind === 'url' || result.kind === 'search') {
    void loadInTab(tab, /** @type {string} */ (result.url))
  } else if (result.kind === 'external') {
    shell.openExternal(/** @type {string} */ (result.url)).catch(() => {})
  }
  return { kind: result.kind, reason: result.reason }
}

/**
 * Open input from Troy's chrome in a new tab without ever passing the raw
 * string to WebContents.loadURL().
 *
 * @param {unknown} input
 * @returns {{ kind: string, reason?: string }}
 */
function openNewTab(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text) {
    selectTab(createTab())
    return { kind: 'empty' }
  }

  const result = resolveNavigation(text)
  if (result.kind === 'url' || result.kind === 'search') {
    selectTab(createTab(/** @type {string} */ (result.url)))
  } else {
    selectTab(createTab())
    if (result.kind === 'external') {
      shell.openExternal(/** @type {string} */ (result.url)).catch(() => {})
    }
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

function orderedTabIds() {
  return [...tabs.keys()]
}

/** @param {number} delta */
function selectRelativeTab(delta) {
  const order = orderedTabIds()
  if (order.length < 2) return
  const current = Math.max(0, order.indexOf(activeTabId))
  selectTab(order[(current + delta + order.length) % order.length])
}

function focusOmnibox() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('omni:focus')
}

function requestPageRead() {
  if (!panelOpen) togglePanel()
  win?.webContents.send('agent:read-requested')
}

function stopAgentAndVoice() {
  const voiceWasActive = Boolean(voiceTranscription || Date.now() < microphoneCaptureUntil)
  microphoneCaptureUntil = 0
  voiceShortcutDown = false
  sendVoiceShortcut('cancel')
  voiceTranscription?.abort(new DOMException('stopped by the user', 'AbortError'))
  voiceTranscription = null
  return agents().stop() || voiceWasActive
}

function activeBookmarkPage() {
  const tab = tabs.get(activeTabId)
  if (!alive(tab)) return null
  const url = tab.view.webContents.getURL()
  if (!/^https?:\/\//i.test(url)) return null
  return { url, title: tab.view.webContents.getTitle() || hostOf(url) }
}

function toggleActiveBookmark() {
  const page = activeBookmarkPage()
  if (!page) return { error: 'only HTTP and HTTPS pages can be bookmarked' }
  const result = toggleBookmark(bookmarksFile(app.getPath('userData')), page)
  bookmarksCache = result.entries
  notify(result.bookmarked ? `Bookmarked ${page.title || page.url}.` : `Removed bookmark for ${page.title || page.url}.`)
  return { bookmarked: result.bookmarked }
}

/** @type {ReturnType<typeof createCommandRegistry> | null} */
let commandRegistry = null

function commandContext() {
  const wc = activeContents()
  const page = activeBookmarkPage()
  return {
    tabCount: tabs.size,
    activeTabId,
    canGoBack: Boolean(wc?.navigationHistory.canGoBack()),
    canGoForward: Boolean(wc?.navigationHistory.canGoForward()),
    bookmarkable: page !== null,
    bookmarked: page ? isBookmarked(bookmarks(), page.url) : false,
    agentRunning: Boolean(agentController?.running),
    stopAvailable: Boolean(agentController?.running || voiceTranscription || Date.now() < microphoneCaptureUntil),
  }
}

function commands() {
  if (commandRegistry) return commandRegistry
  commandRegistry = createCommandRegistry([
    {
      id: 'tab.new',
      title: 'New tab',
      category: 'Tabs',
      keywords: ['open tab', 'create tab'],
      shortcut: '⌘T / Ctrl+T',
      run: () => openNewTab(''),
    },
    {
      id: 'tab.close',
      title: 'Close current tab',
      category: 'Tabs',
      keywords: ['remove tab'],
      shortcut: '⌘W / Ctrl+W',
      enabled: (context) => context.tabCount > 0,
      run: () => closeTab(activeTabId),
    },
    {
      id: 'tab.next',
      title: 'Switch to next tab',
      category: 'Tabs',
      keywords: ['cycle tabs', 'right tab'],
      enabled: (context) => context.tabCount > 1,
      run: () => selectRelativeTab(1),
    },
    {
      id: 'tab.previous',
      title: 'Switch to previous tab',
      category: 'Tabs',
      keywords: ['cycle tabs', 'left tab'],
      enabled: (context) => context.tabCount > 1,
      run: () => selectRelativeTab(-1),
    },
    {
      id: 'nav.back',
      title: 'Go back',
      category: 'Navigation',
      shortcut: '⌘[ / Ctrl+[',
      enabled: (context) => context.canGoBack,
      run: goBack,
    },
    {
      id: 'nav.forward',
      title: 'Go forward',
      category: 'Navigation',
      shortcut: '⌘] / Ctrl+]',
      enabled: (context) => context.canGoForward,
      run: goForward,
    },
    {
      id: 'nav.reload',
      title: 'Reload page',
      category: 'Navigation',
      shortcut: '⌘R / Ctrl+R',
      run: reload,
    },
    {
      id: 'nav.focus',
      title: 'Focus address bar',
      category: 'Navigation',
      keywords: ['omnibox', 'location'],
      shortcut: '⌘L / Ctrl+L',
      run: focusOmnibox,
    },
    {
      id: 'panel.toggle',
      title: 'Toggle agent panel',
      category: 'Agent',
      shortcut: '⌘⇧A / Ctrl+Shift+A',
      run: togglePanel,
    },
    {
      id: 'page.read',
      title: 'Read this page',
      category: 'Agent',
      keywords: ['extract page', 'page markdown'],
      run: requestPageRead,
    },
    {
      id: 'agent.stop',
      title: 'Stop agent run',
      category: 'Agent',
      shortcut: '⌘. / Ctrl+.',
      enabled: (context) => context.stopAvailable,
      run: stopAgentAndVoice,
    },
    {
      id: 'agent.clear',
      title: 'Clear agent conversation',
      category: 'Agent',
      enabled: (context) => !context.agentRunning,
      run: () => agents().clear(activeTabId),
    },
    {
      id: 'bookmark.toggle',
      title: 'Toggle bookmark for this page',
      category: 'Bookmarks',
      keywords: ['save page', 'remove bookmark'],
      shortcut: '⌘D / Ctrl+D',
      enabled: (context) => context.bookmarkable,
      run: toggleActiveBookmark,
    },
  ])
  return commandRegistry
}

/** @param {string} id */
function runCommand(id) {
  return commands().execute(id, commandContext())
}

function createPaletteView() {
  if (!win || win.isDestroyed() || paletteView) return paletteView
  paletteView = new WebContentsView({
    webPreferences: {
      preload: path.join(dir, 'palette-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  paletteView.setVisible(false)
  win.contentView.addChildView(paletteView)
  const wc = paletteView.webContents
  installVoiceShortcut(wc)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event, target) => {
    if (documentUrl(target) !== PALETTE_URL) event.preventDefault()
  })
  void wc.loadURL(PALETTE_URL)
  layoutPalette()
  return paletteView
}

function openPalette() {
  const view = createPaletteView()
  if (!view || !win || win.isDestroyed()) return false
  // A tab created after the palette becomes a later sibling in the content
  // view and would otherwise composite above it. Re-add to bring it to front.
  try {
    win.contentView.removeChildView(view)
    win.contentView.addChildView(view)
  } catch {
    return false
  }
  paletteOpen = true
  paletteQuery = null
  layoutPalette()
  view.setVisible(true)
  const focus = () => {
    if (!paletteOpen || view.webContents.isDestroyed()) return
    view.webContents.send('palette:open')
    view.webContents.focus()
  }
  if (view.webContents.isLoadingMainFrame()) view.webContents.once('did-finish-load', focus)
  else focus()
  return true
}

function closePalette() {
  paletteOpen = false
  paletteQuery = null
  if (paletteView) paletteView.setVisible(false)
  activeContents()?.focus()
}

/** @param {string} query */
function queryPalette(query) {
  const built = buildPaletteResults({
    query: query.slice(0, 256),
    commands: commands().list(commandContext()),
    tabs: [...tabs.values()].filter(alive).map((tab) => ({
      id: tab.id,
      title: tabTitle(tab),
      url: displayUrl(tab),
      active: tab.id === activeTabId,
    })),
    bookmarks: bookmarks(),
    history: settings().rememberHistory ? historyEntries() : [],
    resolve: resolveNavigation,
  })
  const queryId = `q${++paletteQueryCounter}`
  /** @type {Map<string, any>} */
  const stored = new Map()
  const results = built.map((result, index) => {
    const id = `r${index}`
    stored.set(id, result)
    return {
      id,
      kind: result.kind,
      title: result.title,
      subtitle: result.subtitle,
      shortcut: result.shortcut,
    }
  })
  paletteQuery = { id: queryId, results: stored }
  return { queryId, results }
}

/** @param {{ queryId?: unknown, resultId?: unknown, openInNewTab?: unknown }} selection */
async function executePalette(selection) {
  const queryId = String(selection?.queryId ?? '')
  const resultId = String(selection?.resultId ?? '')
  if (!paletteQuery || paletteQuery.id !== queryId) return { error: 'that palette query is no longer active' }
  const result = paletteQuery.results.get(resultId)
  if (!result) return { error: 'unknown palette result' }
  closePalette()

  if (result.kind === 'command') {
    return runCommand(String(result.payload.commandId ?? ''))
  }
  if (result.kind === 'tab') {
    selectTab(Number(result.payload.tabId))
    return { ok: true }
  }

  const target = result.kind === 'navigation' ? result.payload.input : result.payload.url
  if (typeof target !== 'string' || !target) return { error: 'that result has no navigable target' }
  if (selection.openInNewTab) return openNewTab(target)
  return navigate(target)
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
    // Agent launches must not take focus. 'background' still shows the window,
    // just without activating the app; 'hidden' keeps it off screen until the
    // dock/reopen asks for it, while paintWhenInitiallyHidden keeps pages
    // renderable so the read pipeline's screenshots still work.
    show: launchMode === 'foreground',
    paintWhenInitiallyHidden: launchMode !== 'foreground',
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (launchMode === 'background') {
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return
      win.showInactive()
    })
  }

  installVoiceShortcut(win.webContents)
  win.on('blur', () => {
    if (!voiceShortcutDown) return
    voiceShortcutDown = false
    sendVoiceShortcut('cancel')
  })

  // Troy's chrome is a fixed local document, not a general browser surface.
  // If a compromised renderer tries to navigate or open a child window, keep
  // the privileged preload attached to the page it was written for.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (documentUrl(target) !== CHROME_URL) event.preventDefault()
  })
  void win.loadURL(CHROME_URL)
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
    agentController?.stop('cancelled because the window closed')
    voiceTranscription?.abort(new DOMException('window closed', 'AbortError'))
    voiceTranscription = null
    microphoneCaptureUntil = 0
    agentController = null
    win = null
    paletteView = null
    paletteOpen = false
    paletteQuery = null
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
        { id: 'new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => void runCommand('tab.new') },
        {
          id: 'close-tab',
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => void runCommand('tab.close'),
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
          id: 'command-palette',
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          click: openPalette,
        },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => void runCommand('nav.focus'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => void runCommand('nav.reload') },
        {
          id: 'toggle-panel',
          label: 'Toggle Agent Panel',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => void runCommand('panel.toggle'),
        },
        {
          id: 'stop-agent',
          label: 'Stop Agent',
          accelerator: 'CmdOrCtrl+.',
          click: () => void runCommand('agent.stop'),
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
      label: 'Bookmarks',
      submenu: [
        {
          id: 'toggle-bookmark',
          label: 'Toggle Bookmark for This Page',
          accelerator: 'CmdOrCtrl+D',
          click: () => void runCommand('bookmark.toggle'),
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        { id: 'back', label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => void runCommand('nav.back') },
        { id: 'forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => void runCommand('nav.forward') },
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

/**
 * Is this call from Troy's one privileged chrome document.
 *
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function fromChrome(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
  const url = event.senderFrame?.url ?? event.sender.getURL()
  return documentUrl(url) === CHROME_URL
}

/**
 * Wrap a handler so a tab page, extension frame or navigated renderer cannot
 * invoke browser-chrome capabilities merely because it knows a channel name.
 *
 * @param {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown} handler
 * @returns {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown}
 */
function chromeOnly(handler) {
  return (event, ...args) => {
    if (!fromChrome(event)) throw new Error('this channel is for Troy chrome')
    return handler(event, ...args)
  }
}

/** @param {import('electron').IpcMainInvokeEvent} event */
function fromPalette(event) {
  if (!paletteView || event.sender !== paletteView.webContents) return false
  const url = event.senderFrame?.url ?? event.sender.getURL()
  return documentUrl(url) === PALETTE_URL
}

/**
 * @param {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown} handler
 * @returns {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown}
 */
function paletteOnly(handler) {
  return (event, ...args) => {
    if (!fromPalette(event)) throw new Error('this channel is for Troy palette')
    return handler(event, ...args)
  }
}

ipcMain.handle('tab:new', chromeOnly((_e, input) => openNewTab(input)))
ipcMain.handle('tab:select', chromeOnly((_e, id) => selectTab(Number(id))))
ipcMain.handle('tab:close', chromeOnly((_e, id) => closeTab(Number(id))))
ipcMain.handle('nav:back', chromeOnly(() => goBack()))
ipcMain.handle('nav:forward', chromeOnly(() => goForward()))
ipcMain.handle('nav:reload', chromeOnly(() => reload()))
ipcMain.handle('nav:go', chromeOnly((_e, input) => navigate(String(input ?? '').slice(0, 8192))))
ipcMain.handle('panel:toggle', chromeOnly(() => togglePanel()))
ipcMain.handle('palette:query', paletteOnly((_e, input) => {
  if (!paletteOpen) throw new Error('the palette is closed')
  return queryPalette(String(input ?? '').slice(0, 256))
}))
ipcMain.handle('palette:execute', paletteOnly((_e, selection) => {
  if (!paletteOpen || !selection || typeof selection !== 'object') {
    return { error: 'the palette is closed or the selection is invalid' }
  }
  return executePalette(selection)
}))
ipcMain.handle('palette:close', paletteOnly(() => closePalette()))
ipcMain.handle('agent:state', chromeOnly(() => agentState()))
ipcMain.handle('agent:settings', chromeOnly((_e, change) => {
  if (!change || typeof change !== 'object') return { error: 'invalid agent settings' }
  const provider = String(change.provider ?? settings().agentProvider)
  if (!PROVIDERS.has(provider)) return { error: 'unknown provider' }
  const requestedModel = String(change.model ?? '').trim()
  const model = requestedModel || (provider === settings().agentProvider
    ? settings().agentModel
    : DEFAULT_MODELS[/** @type {keyof typeof DEFAULT_MODELS} */ (provider)])
  if (!model || model.length > 160) return { error: 'invalid model name' }
  updateSettings({ agentProvider: provider, agentModel: model })
  return agentState()
}))
ipcMain.handle('agent:key:set', chromeOnly((_e, input) => {
  if (!input || typeof input !== 'object') return { error: 'invalid key request' }
  const provider = String(input.provider ?? '')
  const key = String(input.key ?? '')
  if (!PROVIDERS.has(provider)) return { error: 'unknown provider' }
  if (key.length > 4096) return { error: 'the key is too long' }
  const result = setKey(keysFile(app.getPath('userData')), keyCrypt(), provider, key)
  if ('error' in result) return result
  keyStatusCache = null
  return { ok: true, status: storedKeyStatus() }
}))
ipcMain.handle('agent:key:clear', chromeOnly((_e, providerInput) => {
  const provider = String(providerInput ?? '')
  if (!PROVIDERS.has(provider)) return { error: 'unknown provider' }
  clearKey(keysFile(app.getPath('userData')), provider)
  keyStatusCache = null
  return { ok: true, status: storedKeyStatus() }
}))
ipcMain.handle('agent:submit', chromeOnly((_e, text) => agents().submit({
  text,
  provider: settings().agentProvider,
  model: settings().agentModel,
})))
ipcMain.handle('agent:stop', chromeOnly(() => ({ stopped: stopAgentAndVoice() })))
ipcMain.handle('agent:clear', chromeOnly(() => agents().clear(activeTabId)))
ipcMain.handle('agent:grant-origin', chromeOnly((_e, origin) => agents().grantOrigin(activeTabId, origin)))
ipcMain.handle('voice:state', chromeOnly(() => voiceState()))
ipcMain.handle('voice:capture:start', chromeOnly(() => {
  const state = voiceState()
  if (!state.available) return { error: state.reason }
  microphoneCaptureUntil = Date.now() + 90_000
  return { ok: true, expiresAt: microphoneCaptureUntil }
}))
ipcMain.handle('voice:capture:end', chromeOnly(() => {
  microphoneCaptureUntil = 0
  return { ok: true }
}))
ipcMain.handle('voice:transcribe', chromeOnly(async (_e, input) => {
  microphoneCaptureUntil = 0
  let wav
  if (input instanceof ArrayBuffer) wav = Buffer.from(input)
  else if (ArrayBuffer.isView(input)) wav = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  else return { error: 'voice input must be an audio buffer' }
  if (wav.length > MAX_VOICE_BYTES) return { error: 'voice input is too large' }

  voiceTranscription?.abort(new DOMException('replaced by a newer transcription', 'AbortError'))
  const controller = new AbortController()
  voiceTranscription = controller
  try {
    return await transcribeLocalWav(wav, localVoiceAssets(), { signal: controller.signal })
  } finally {
    if (voiceTranscription === controller) voiceTranscription = null
  }
}))

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
  return documentUrl(url) === NEW_TAB_URL
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

// The new tab page's surface, refused for every other page. Shortcuts were
// removed outright: a grid nobody could populate without the broken dialog
// is worse than no grid, and the page reads better as one honest search box.
ipcMain.handle(
  'newtab:state',
  newTabOnly(() => {
    const current = settings()
    return {
      rememberHistory: current.rememberHistory,
      blockTrackers: current.blockTrackers,
    }
  }),
)

ipcMain.handle(
  'newtab:setting',
  newTabOnly((_e, /** @type {{key?: unknown, value?: unknown}} */ change) => {
    const key = String(change?.key ?? '')
    if (key !== 'rememberHistory' && key !== 'blockTrackers') return settings()
    return updateSettings({ [key]: Boolean(change?.value) })
  }),
)

// Reading the live tab through the real pipeline: settle, extract, cover,
// transcribe, fuse. The heavy lifting lives in src/read and the tab adapter
// in readPort.js; this handler stays thin on purpose. Attaches CDP briefly,
// the same way the Cdp port does, and always detaches so DevTools stay usable.
ipcMain.handle(
  'agent:read',
  chromeOnly(async () => {
    const wc = activeContents()
    if (!wc) return { error: 'no active tab' }
    try {
      const doc = await readTab(wc, { ocr: selectedOcr() })
      return summariseDocument(doc)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  }),
)

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
/** @type {Array<{url: string, title: string, addedAt: string}> | null} */
let bookmarksCache = null
/** @type {Array<{url: string, title: string, visitedAt: string}> | null} */
let historyCache = null
/** @type {ReturnType<typeof keyStatus> | null} */
let keyStatusCache = null

function storedKeyStatus() {
  if (!keyStatusCache) keyStatusCache = keyStatus(keysFile(app.getPath('userData')), keyCrypt())
  return keyStatusCache
}

function bookmarks() {
  if (!bookmarksCache) bookmarksCache = readBookmarks(bookmarksFile(app.getPath('userData')))
  return bookmarksCache
}

function historyEntries() {
  if (!historyCache) historyCache = readHistory(historyFile(app.getPath('userData')))
  return historyCache
}

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
    historyCache = []
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
  historyCache = recordVisit(historyFile(app.getPath('userData')), { url, title: wc.getTitle() || hostOf(url) })
}

app.whenReady().then(async () => {
  // The About panel is the one page every user eventually reads, so it says
  // plainly what Troy is and where its author's other work lives.
  app.setAboutPanelOptions({
    applicationName: 'Troy',
    applicationVersion: app.getVersion(),
    credits: [
      'A browser an agent can actually read and drive.',
      '',
      'Troy is a real Chromium browser with its own chrome, built so an AI agent can attach to the window you are already signed into and work the page with you. Most automation starts a fresh, empty browser; Troy inverts that: you browse in it, and the agent joins your session.',
      '',
      'Made by Anish Kr Singh.',
      'More of my work: https://anishfyi.com and https://velofy.co',
      'Project home: https://anishfyi.com/troy',
    ].join('\n'),
  })

  // Before anything else. An uncaught error in a handler used to end the
  // browser, tabs and all, and report itself only as "Troy quit unexpectedly".
  installSafetyNet({
    logFile: path.join(app.getPath('userData'), 'troy-errors.log'),
    onError: (scope, err) => {
      console.error(`[troy] ${scope}:`, err)
      notify('Something went wrong inside Troy. It stayed open; the details are in troy-errors.log.')
    },
  })

  // An agent browser should not hand out privileged device access because a
  // page asked. Check and request paths use the same policy so Chromium cannot
  // observe one answer during probing and receive another at prompt time.
  /**
   * @param {import('electron').WebContents | null} wc
   * @param {string} permission
   * @param {any} [details]
   * @param {boolean} [strictMedia]
   */
  const permissionAllowed = (wc, permission, details = {}, strictMedia = false) => {
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true
    if (permission !== 'media') return false
    if (!wc || !win || wc !== win.webContents || documentUrl(wc.getURL()) !== CHROME_URL) return false
    if (Date.now() >= microphoneCaptureUntil) return false
    const mediaTypes = [
      ...(Array.isArray(details.mediaTypes) ? details.mediaTypes : []),
      details.mediaType,
    ].filter(Boolean).map(String)
    if (mediaTypes.some((type) => /video/i.test(type))) return false
    return strictMedia ? mediaTypes.some((type) => /audio/i.test(type)) : true
  }
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permissionAllowed(wc, permission, details),
  )
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissionAllowed(wc, permission, details, true))
  })
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const tab = [...tabs.values()].find((candidate) => alive(candidate) && candidate.view.webContents === webContents)
    if (!tab || agentController?.activeTabId !== tab.id) return
    event.preventDefault()
    item.cancel()
    agentController.block(tab.id, 'downloads are never autonomous')
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else if (win && !win.isDestroyed() && !win.isVisible()) {
    // A hidden launch stays hidden until the person actually asks for it,
    // which on macOS means clicking the dock icon or reopening the app.
    win.show()
  }
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
        paletteOpen,
        launchMode,
        windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
        windowFocused: Boolean(win && !win.isDestroyed() && win.isFocused()),
        paletteBounds: paletteView ? paletteView.getBounds() : null,
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
