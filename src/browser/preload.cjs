// The only bridge between Troy's chrome UI and the main process. Nothing
// here exposes a general IPC channel or node itself: the renderer gets a
// fixed list of named actions and two subscriptions, so a compromised chrome
// page still cannot reach the filesystem or arbitrary main-process code.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('troy', {
  /** @param {string} [url] */
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  /** @param {number} id */
  selectTab: (id) => ipcRenderer.invoke('tab:select', id),
  /** @param {number} id */
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  /** @param {string} input @returns {Promise<{kind: string, reason?: string}>} */
  go: (input) => ipcRenderer.invoke('nav:go', input),
  togglePanel: () => ipcRenderer.invoke('panel:toggle'),
  read: () => ipcRenderer.invoke('agent:read'),
  /** @param {(payload: unknown) => void} handler */
  onTabs: (handler) => {
    /** @type {(event: unknown, payload: unknown) => void} */
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('tabs:changed', listener)
    return () => ipcRenderer.removeListener('tabs:changed', listener)
  },
  /** @param {(reason: string) => void} handler */
  onNotice: (handler) => {
    /** @type {(event: unknown, reason: string) => void} */
    const listener = (_event, reason) => handler(reason)
    ipcRenderer.on('chrome:notice', listener)
    return () => ipcRenderer.removeListener('chrome:notice', listener)
  },
  /** @param {() => void} handler */
  onFocusOmnibox: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('omni:focus', listener)
    return () => ipcRenderer.removeListener('omni:focus', listener)
  },
})
