// The failure page. It is a real page in the tab, not chrome, so it only
// knows what the main process put in the query string. "Try again" reloads,
// and the main process reloads the address that failed rather than this
// page, so one click gets you back to what you asked for.

const params = new URLSearchParams(location.search)

const target = params.get('u') ?? ''
const reason = params.get('r') ?? 'The page could not be reached.'

document.getElementById('url').textContent = target
document.getElementById('reason').textContent = reason

document.getElementById('retry').addEventListener('click', () => {
  location.replace(target || 'about:blank')
})
