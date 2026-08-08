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

import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

const CHROME_HEIGHT = 88 // tab strip plus toolbar, matched in chrome.css
const PANEL_WIDTH = 340 // agent panel, when open

/** @type {BrowserWindow | null} */
let win = null
/** @type {Map<number, WebContentsView>} */
const tabs = new Map()
let nextTabId = 1
let activeTabId = 0
let panelOpen = false

const NEW_TAB_URL = `file://${path.join(dir, 'renderer', 'newtab.html')}`

function layoutActive() {
  if (!win) return
  const view = tabs.get(activeTabId)
  if (!view) return
  const { width, height } = win.getContentBounds()
  const right = panelOpen ? PANEL_WIDTH : 0
  view.setBounds({
    x: 0,
    y: CHROME_HEIGHT,
    width: Math.max(0, width - right),
    height: Math.max(0, height - CHROME_HEIGHT),
  })
}

/** Tell the chrome what every tab looks like now. */
function syncChrome() {
  if (!win || win.isDestroyed()) return
  const list = [...tabs.entries()].map(([id, view]) => ({
    id,
    title: view.webContents.getTitle() || 'New Tab',
    url: view.webContents.getURL(),
    active: id === activeTabId,
  }))
  const active = tabs.get(activeTabId)
  win.webContents.send('tabs:changed', {
    tabs: list,
    canGoBack: active ? active.webContents.navigationHistory.canGoBack() : false,
    canGoForward: active ? active.webContents.navigationHistory.canGoForward() : false,
    loading: active ? active.webContents.isLoading() : false,
    panelOpen,
  })
}

function createTab(url = NEW_TAB_URL) {
  if (!win) return 0
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const id = nextTabId++
  tabs.set(id, view)
  win.contentView.addChildView(view)

  const wc = view.webContents
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
    wc.on(ev, syncChrome)
  }
  // A page asking for a new window gets a new tab, never a popup we do not
  // control, and an external protocol goes to the OS rather than nowhere.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      selectTab(createTab(target))
    } else {
      shell.openExternal(target).catch(() => {})
    }
    return { action: 'deny' }
  })

  wc.loadURL(url)
  return id
}

function selectTab(id) {
  const view = tabs.get(id)
  if (!view) return
  for (const [otherId, other] of tabs) other.setVisible(otherId === id)
  activeTabId = id
  layoutActive()
  syncChrome()
}

function closeTab(id) {
  const view = tabs.get(id)
  if (!view || !win) return
  tabs.delete(id)
  win.contentView.removeChildView(view)
  view.webContents.close()
  if (activeTabId === id) {
    const last = [...tabs.keys()].pop()
    if (last) selectTab(last)
    else selectTab(createTab())
  } else {
    syncChrome()
  }
}

/** An omnibox entry is a URL if it parses as one, otherwise a search. */
export function resolveOmnibox(input) {
  const text = input.trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$|\?)/.test(text)) return `https://${text}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#202124',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(dir, 'renderer', 'chrome.html'))
  win.on('resize', layoutActive)
  win.webContents.once('did-finish-load', () => {
    selectTab(createTab())
  })
  win.on('closed', () => {
    win = null
    tabs.clear()
  })
}

ipcMain.handle('tab:new', (_e, url) => selectTab(createTab(url || undefined)))
ipcMain.handle('tab:select', (_e, id) => selectTab(id))
ipcMain.handle('tab:close', (_e, id) => closeTab(id))
ipcMain.handle('nav:back', () => {
  const wc = tabs.get(activeTabId)?.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
})
ipcMain.handle('nav:forward', () => {
  const wc = tabs.get(activeTabId)?.webContents
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
})
ipcMain.handle('nav:reload', () => tabs.get(activeTabId)?.webContents.reload())
ipcMain.handle('nav:go', (_e, input) => {
  const url = resolveOmnibox(String(input ?? ''))
  if (url) tabs.get(activeTabId)?.webContents.loadURL(url)
})
ipcMain.handle('panel:toggle', () => {
  panelOpen = !panelOpen
  layoutActive()
  syncChrome()
  return panelOpen
})

// Reading the live tab. The engine lands here in the next step; today this
// proves the CDP attach path the whole design rests on, using the same
// protocol calls the Cdp port makes.
ipcMain.handle('agent:read', async () => {
  const view = tabs.get(activeTabId)
  if (!view) return { error: 'no active tab' }
  const wc = view.webContents
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    const { result } = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: 'document.title + "\\n" + document.body.innerText.slice(0, 4000)',
      returnByValue: true,
    })
    return { url: wc.getURL(), text: String(result.value ?? '') }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) }
  }
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
