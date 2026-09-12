// The new tab page's own behaviour.
//
// Shortcuts were removed outright: the add dialog was broken for weeks, and
// a grid nobody can populate is worse than no grid. What remains is the
// settings panel; everything else on this page works without script.

const bridge = window.troyNewTab
const settingsBtn = document.getElementById('settingsbtn')
const settingsEl = document.getElementById('settings')

async function start() {
  // No bridge means this page is open somewhere it should not be. The search
  // box still works, because that never needed one.
  if (!bridge) return

  const state = await bridge.state()

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
}

start()
