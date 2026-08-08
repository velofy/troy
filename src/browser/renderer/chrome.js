// Troy's chrome behaviour. Talks to the main process only through the
// fixed surface `preload.cjs` exposes on window.troy.

const tabsEl = document.getElementById('tabs')
const omni = document.getElementById('omni')
const backBtn = document.getElementById('back')
const forwardBtn = document.getElementById('forward')
const panelBtn = document.getElementById('panel')
const panelEl = document.getElementById('agentpanel')
const panelBody = document.getElementById('panelbody')

// True while the user is typing, so a background tab finishing a load does
// not yank the address out from under them mid-edit.
let editingOmni = false

function renderTabs(state) {
  tabsEl.textContent = ''
  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (tab.active ? ' active' : '')
    el.title = tab.title

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

    if (tab.active && !editingOmni) {
      omni.value = tab.url.startsWith('file://') ? '' : tab.url
    }
  }
  backBtn.disabled = !state.canGoBack
  forwardBtn.disabled = !state.canGoForward
  panelEl.hidden = !state.panelOpen
  panelBtn.classList.toggle('on', state.panelOpen)
}

window.troy.onTabs(renderTabs)

document.getElementById('newtab').addEventListener('click', () => window.troy.newTab())
backBtn.addEventListener('click', () => window.troy.back())
forwardBtn.addEventListener('click', () => window.troy.forward())
document.getElementById('reload').addEventListener('click', () => window.troy.reload())
panelBtn.addEventListener('click', () => window.troy.togglePanel())

omni.addEventListener('focus', () => {
  editingOmni = true
  omni.select()
})
omni.addEventListener('blur', () => {
  editingOmni = false
})
omni.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.troy.go(omni.value)
    omni.blur()
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

// Keyboard shortcuts people expect from a browser.
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  if (e.key === 't') { e.preventDefault(); window.troy.newTab() }
  else if (e.key === 'l') { e.preventDefault(); omni.focus() }
  else if (e.key === 'r') { e.preventDefault(); window.troy.reload() }
  else if (e.key === '[') { e.preventDefault(); window.troy.back() }
  else if (e.key === ']') { e.preventDefault(); window.troy.forward() }
})
