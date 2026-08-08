// The only bridge between Troy's chrome UI and the main process. Nothing
// here exposes a general IPC channel or node itself: the renderer gets a
// fixed list of named actions and one subscription, so a compromised chrome
// page still cannot reach the filesystem or arbitrary main-process code.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('troy', {
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  selectTab: (id) => ipcRenderer.invoke('tab:select', id),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  go: (input) => ipcRenderer.invoke('nav:go', input),
  togglePanel: () => ipcRenderer.invoke('panel:toggle'),
  read: () => ipcRenderer.invoke('agent:read'),
  onTabs: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('tabs:changed', listener)
    return () => ipcRenderer.removeListener('tabs:changed', listener)
  },
})
