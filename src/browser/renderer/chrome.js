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

function renderTabs(state) {
  tabsEl.textContent = ''
  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (tab.active ? ' active' : '')
    el.title = tab.title

    if (tab.favicon) {
      const img = document.createElement('img')
      img.className = 'fav'
      img.src = tab.favicon
      img.alt = ''
      img.addEventListener('error', () => img.remove())
      el.append(img)
    }

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = tab.title
    label.addEventListener('click', () => window.troy.selectTab(tab.id))

    const close = document.createElement('button')
    close.className = 'x'
    close.textContent = '×'
    close.setAttribute('aria-label', `Close ${tab.title}`)
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      window.troy.closeTab(tab.id)
    })

    el.append(label, close)
    tabsEl.append(el)

    if (tab.active && !editingOmni) omni.value = tab.url
  }
  backBtn.disabled = !state.canGoBack
  forwardBtn.disabled = !state.canGoForward
  reloadBtn.classList.toggle('loading', Boolean(state.loading))
  panelEl.hidden = !state.panelOpen
  panelBtn.classList.toggle('on', state.panelOpen)
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
