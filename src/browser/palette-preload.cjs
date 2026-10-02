// Fixed bridge for the isolated command palette. Result payloads stay in main;
// the renderer receives and returns only opaque query/result identifiers.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('troyPalette', {
  /** @param {string} text */
  query: (text) => ipcRenderer.invoke('palette:query', text),
  /** @param {string} queryId @param {string} resultId @param {boolean} openInNewTab */
  execute: (queryId, resultId, openInNewTab) =>
    ipcRenderer.invoke('palette:execute', { queryId, resultId, openInNewTab: Boolean(openInNewTab) }),
  close: () => ipcRenderer.invoke('palette:close'),
  /** @param {() => void} handler */
  onOpen: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('palette:open', listener)
    return () => ipcRenderer.removeListener('palette:open', listener)
  },
})
