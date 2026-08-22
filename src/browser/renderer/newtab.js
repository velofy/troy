// The new tab page's own behaviour.
//
// The search box works without any of this: it is a real form and the main
// process catches its submission. Everything here is the extras, so a
// failure to load this file costs you the tiles, not the browser.

const bridge = window.troyNewTab
const tilesEl = document.getElementById('tiles')
const settingsBtn = document.getElementById('settingsbtn')
const settingsEl = document.getElementById('settings')
const addBox = document.getElementById('addbox')
const backdrop = document.getElementById('backdrop')
const addUrl = document.getElementById('addUrl')
const addTitle = document.getElementById('addTitle')
const addErr = document.getElementById('addErr')

function closeAddBox() {
  addBox.hidden = true
  backdrop.hidden = true
}

function openAddBox() {
  addErr.hidden = true
  addUrl.value = ''
  addTitle.value = ''
  backdrop.hidden = false
  addBox.hidden = false
  addUrl.focus()
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(paths, viewBox = '0 0 16 16') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

/** The site's own icon, never a third-party favicon service. */
function faviconUrl(url) {
  try {
    const { origin } = new URL(url)
    return `${origin}/favicon.ico`
  } catch {
    return null
  }
}

function monogram(title, url) {
  const source = (title || url || '?').replace(/^https?:\/\/(www\.)?/, '')
  return source.trim().charAt(0).toUpperCase() || '?'
}

function makeTile(shortcut) {
  const tile = document.createElement('div')
  tile.className = 'tile'

  const open = document.createElement('button')
  open.className = 'face'
  open.title = shortcut.url
  open.addEventListener('click', () => bridge.open(shortcut.url))

  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = monogram(shortcut.title, shortcut.url)

  const src = faviconUrl(shortcut.url)
  if (src) {
    const img = document.createElement('img')
    img.alt = ''
    img.src = src
    // A site with no icon falls back to its initial rather than a broken
    // image, the same rule the tab strip follows.
    img.addEventListener('load', () => {
      badge.textContent = ''
      badge.append(img)
    })
    img.addEventListener('error', () => img.remove())
  }

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = shortcut.title

  open.append(badge, label)

  const remove = document.createElement('button')
  remove.className = 'remove'
  remove.title = `Remove ${shortcut.title}`
  remove.setAttribute('aria-label', `Remove ${shortcut.title}`)
  remove.append(icon(['M4.2 4.2 L9.8 9.8', 'M9.8 4.2 L4.2 9.8'], '0 0 14 14'))
  remove.addEventListener('click', async (e) => {
    e.stopPropagation()
    renderTiles(await bridge.removeShortcut(shortcut.url))
  })

  tile.append(open, remove)
  return tile
}

function makeAddTile() {
  const tile = document.createElement('div')
  tile.className = 'tile'

  const open = document.createElement('button')
  open.className = 'face add'
  open.title = 'Add shortcut'
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.append(icon(['M8 3.6v8.8', 'M3.6 8h8.8']))
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = 'Add shortcut'
  open.append(badge, label)
  open.addEventListener('click', openAddBox)

  tile.append(open)
  return tile
}

function renderTiles(shortcuts) {
  tilesEl.textContent = ''
  for (const shortcut of shortcuts) tilesEl.append(makeTile(shortcut))
  tilesEl.append(makeAddTile())
  tilesEl.hidden = false
}

async function save() {
  const url = addUrl.value.trim()
  if (!url) {
    addErr.textContent = 'Type an address first.'
    addErr.hidden = false
    return
  }
  const shortcuts = await bridge.addShortcut(url, addTitle.value.trim())
  if (!shortcuts.some((s) => s.url.includes(url.replace(/^https?:\/\//, '').split('/')[0]))) {
    addErr.textContent = 'Troy only opens http and https addresses.'
    addErr.hidden = false
    return
  }
  closeAddBox()
  renderTiles(shortcuts)
}

async function start() {
  // No bridge means this page is open somewhere it should not be. The search
  // box still works, because that never needed one.
  if (!bridge) return

  const state = await bridge.state()
  renderTiles(state.shortcuts)

  document.getElementById('rememberHistory').checked = state.rememberHistory
  document.getElementById('blockTrackers').checked = state.blockTrackers

  settingsBtn.addEventListener('click', () => {
    const open = settingsEl.hidden
    settingsEl.hidden = !open
    settingsBtn.setAttribute('aria-expanded', String(open))
  })

  for (const key of ['rememberHistory', 'blockTrackers']) {
    document.getElementById(key).addEventListener('change', (e) => {
      bridge.setSetting(key, e.target.checked)
    })
  }

  document.getElementById('addSave').addEventListener('click', save)
  document.getElementById('addCancel').addEventListener('click', closeAddBox)
  backdrop.addEventListener('click', closeAddBox)
  for (const input of [addUrl, addTitle]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save()
      if (e.key === 'Escape') closeAddBox()
    })
  }
}

start()
