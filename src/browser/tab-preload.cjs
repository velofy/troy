// The bridge for Troy's own new tab page, inside a tab.
//
// Tabs host arbitrary web pages, so a preload attached to them is attached
// to every site you visit. Two things keep that safe, and only the second
// one is load-bearing:
//
//   1. This file exposes nothing unless the document looks like Troy's new
//      tab page. That is tidiness: a site should not even see the object.
//   2. The main process checks the calling frame's URL on every one of these
//      channels and refuses anything that is not the new tab page. That is
//      the actual guarantee, because it is made where a page cannot reach.
//
// Note what is absent: no node modules. A sandboxed preload cannot require
// `path` or `url`, and an earlier version of this file did, threw on load,
// and silently left the page with no bridge at all.

const { contextBridge, ipcRenderer } = require('electron')

function looksLikeNewTab() {
  try {
    // Reached through globalThis because this file is checked against Node's
    // types, where `location` does not exist.
    const { location } = /** @type {{ location: { href: string } }} */ (
      /** @type {unknown} */ (globalThis)
    )
    const here = new URL(location.href)
    return here.protocol === 'file:' && here.pathname.endsWith('/renderer/newtab.html')
  } catch {
    return false
  }
}

if (looksLikeNewTab()) {
  contextBridge.exposeInMainWorld('troyNewTab', {
    /** @returns {Promise<{shortcuts: Array<{url: string, title: string}>, rememberHistory: boolean, blockTrackers: boolean}>} */
    state: () => ipcRenderer.invoke('newtab:state'),
    /** @param {string} url @param {string} [title] */
    addShortcut: (url, title) => ipcRenderer.invoke('newtab:add', { url, title }),
    /** @param {string} url */
    removeShortcut: (url) => ipcRenderer.invoke('newtab:remove', url),
    /** @param {string} key @param {boolean} value */
    setSetting: (key, value) => ipcRenderer.invoke('newtab:setting', { key, value }),
    /** @param {string} url open a tile, through the same rules as the address bar */
    open: (url) => ipcRenderer.invoke('newtab:open', url),
  })
}
