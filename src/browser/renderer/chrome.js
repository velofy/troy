// Troy's chrome behaviour. Talks to the main process only through the
// fixed surface `preload.cjs` exposes on window.troy.
//
// Note there are no keyboard shortcuts in here. They live in the real
// application menu, because this page only holds keyboard focus until you
// click into a web page, and a renderer-side listener would both go silent
// while you browse and fire a second time whenever the menu accelerator
// already fired.

const tabsEl = document.getElementById('tabs')
const omni = document.getElementById('omni')
const backBtn = document.getElementById('back')
const forwardBtn = document.getElementById('forward')
const reloadBtn = document.getElementById('reload')
const panelBtn = document.getElementById('panel')
const panelEl = document.getElementById('agentpanel')
const panelBody = document.getElementById('panelbody')
const noticeEl = document.getElementById('notice')

// True while the user is typing, so a background tab finishing a load does
// not yank the address out from under them mid-edit.
let editingOmni = false
let noticeTimer = 0

// One entry per live tab, so a state update edits the strip in place.
//
// Emptying the strip and rebuilding it on every update looked simpler and was
// wrong: state arrives several times per navigation, and each rebuild threw
// away the favicon <img> and made the browser fetch it again, so tabs
// flickered while a page loaded and the layout was recomputed for the whole
// strip every time.
const live = new Map()

const SVG_NS = 'http://www.w3.org/2000/svg'

function cross() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  // The cross fills its box rather than floating in the middle of a larger
  // one. At the old proportions it drew a 4px mark inside a 20px button and
  // read as a smudge rather than a close control.
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M1.4 1.4 L8.6 8.6 M8.6 1.4 L1.4 8.6')
  svg.append(path)
  return svg
}

// The loading bar. Kept here rather than derived from state on every update,
// because the whole effect depends on when each step happens.
const progressEl = document.getElementById('progress')
let progressValue = 0
let progressTimer = 0
let progressFade = 0
let loadingNow = false

function paintProgress() {
  progressEl.style.transform = `scaleX(${progressValue})`
}

function startProgress() {
  clearTimeout(progressFade)
  clearInterval(progressTimer)
  progressEl.classList.remove('done')
  progressEl.classList.add('on')
  // Straight to 30%. A bar that starts at zero feels slower than the page is.
  progressValue = 0.3
  paintProgress()
  progressTimer = setInterval(() => {
    // Ease toward 90 and never reach it, so it keeps moving without ever
    // claiming to be finished before the page is.
    progressValue += (0.9 - progressValue) * 0.09
    paintProgress()
  }, 120)
}

function finishProgress() {
  clearInterval(progressTimer)
  progressTimer = 0
  progressEl.classList.add('done')
  progressValue = 1
  paintProgress()
  progressFade = setTimeout(() => {
    progressEl.classList.remove('on')
    progressValue = 0
    paintProgress()
  }, 220)
}

function makeTab(id) {
  const root = document.createElement('div')
  root.className = 'tab'

  const fav = document.createElement('img')
  fav.className = 'fav'
  fav.alt = ''
  fav.hidden = true

  const spin = document.createElement('span')
  spin.className = 'spin'
  spin.hidden = true

  const entry = { root, fav, spin, label: null, close: null, badFavicon: null }

  // A site with no icon still reports /favicon.ico, and the server answers
  // with its HTML 404 page, which an <img> cannot decode. Hiding it on error
  // is not enough on its own: the next state update would set the same src
  // and show the broken glyph again, so remember which one failed.
  fav.addEventListener('error', () => {
    entry.badFavicon = fav.getAttribute('src')
    fav.hidden = true
  })

  const label = document.createElement('span')
  label.className = 'label'
  label.addEventListener('click', () => window.troy.selectTab(id))

  // Drawn, not typed. The "×" character sits on the font's math axis rather
  // than the middle of its box, so a text close button is always a little
  // high or low, and by a different amount in every font the OS might pick.
  // Two lines in a viewBox are centred by construction, everywhere.
  const close = document.createElement('button')
  close.className = 'x'
  close.append(cross())
  close.title = 'Close tab'
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    window.troy.closeTab(id)
  })

  root.append(spin, fav, label, close)
  entry.label = label
  entry.close = close
  return entry
}

function updateTab(entry, tab) {
  if (entry.label.textContent !== tab.title) {
    entry.label.textContent = tab.title
    entry.root.title = tab.title
    entry.close.setAttribute('aria-label', `Close ${tab.title}`)
  }
  entry.root.classList.toggle('active', tab.active)

  // The spinner takes the icon's place while loading, so the tab does not
  // change width when a page starts or finishes.
  entry.spin.hidden = !tab.loading

  const showFavicon = !tab.loading && tab.favicon && tab.favicon !== entry.badFavicon
  if (showFavicon) {
    if (entry.fav.getAttribute('src') !== tab.favicon) entry.fav.setAttribute('src', tab.favicon)
    entry.fav.hidden = false
  } else {
    entry.fav.hidden = true
    if (!tab.favicon) entry.fav.removeAttribute('src')
  }
}

function renderTabs(state) {
  state.tabs.forEach((tab, index) => {
    let entry = live.get(tab.id)
    if (!entry) {
      entry = makeTab(tab.id)
      live.set(tab.id, entry)
    }
    updateTab(entry, tab)
    if (tabsEl.children[index] !== entry.root) {
      tabsEl.insertBefore(entry.root, tabsEl.children[index] ?? null)
    }
    if (tab.active && !editingOmni) omni.value = tab.url
  })

  const open = new Set(state.tabs.map((tab) => tab.id))
  for (const [id, entry] of live) {
    if (open.has(id)) continue
    entry.root.remove()
    live.delete(id)
  }

  backBtn.disabled = !state.canGoBack
  forwardBtn.disabled = !state.canGoForward
  panelEl.hidden = !state.panelOpen
  panelBtn.classList.toggle('on', state.panelOpen)

  // Only on the edges. Re-running the animation on every state update would
  // restart the bar several times during one navigation.
  const loading = Boolean(state.loading)
  if (loading !== loadingNow) {
    loadingNow = loading
    if (loading) startProgress()
    else finishProgress()
  }
}

/** A refusal is worth a sentence. Silence would read as a broken address bar. */
function showNotice(text) {
  noticeEl.textContent = text
  noticeEl.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeEl.hidden = true
  }, 6000)
}

function hideNotice() {
  clearTimeout(noticeTimer)
  noticeEl.hidden = true
}

window.troy.onTabs(renderTabs)
window.troy.onNotice(showNotice)
window.troy.onFocusOmnibox(() => {
  omni.focus()
  omni.select()
})

document.getElementById('newtab').addEventListener('click', () => window.troy.newTab())
backBtn.addEventListener('click', () => window.troy.back())
forwardBtn.addEventListener('click', () => window.troy.forward())
reloadBtn.addEventListener('click', () => window.troy.reload())
panelBtn.addEventListener('click', () => window.troy.togglePanel())

omni.addEventListener('focus', () => {
  editingOmni = true
  omni.select()
})
omni.addEventListener('blur', () => {
  editingOmni = false
})
omni.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    hideNotice()
    const result = await window.troy.go(omni.value)
    if (result && result.kind === 'refused') showNotice(`Troy will not open that: ${result.reason}`)
    else omni.blur()
  } else if (e.key === 'Escape') {
    omni.blur()
  }
})

document.getElementById('readbtn').addEventListener('click', async () => {
  panelBody.textContent = ''
  const meta = document.createElement('p')
  meta.className = 'readmeta'
  meta.textContent = 'reading the live tab over CDP...'
  panelBody.append(meta)

  const result = await window.troy.read()
  panelBody.textContent = ''

  const info = document.createElement('p')
  info.className = 'readmeta'
  const out = document.createElement('pre')
  out.className = 'readout'

  if (result.error) {
    info.textContent = 'could not read this tab'
    out.textContent = result.error
  } else {
    const chars = result.text.length
    info.textContent = `${result.url}\n${chars} characters, dom only for now`
    out.textContent = result.text
  }
  panelBody.append(info, out)
})
