// Keyboard-first command palette. All executable payloads stay in main; this
// page renders labels and returns only opaque identifiers.

const queryEl = document.getElementById('query')
const resultsEl = document.getElementById('results')
const emptyEl = document.getElementById('empty')

let queryId = ''
let results = []
let selected = 0
let requestVersion = 0
let executing = false
let queryTimer = 0

function select(index) {
  if (results.length === 0) {
    selected = 0
    queryEl.removeAttribute('aria-activedescendant')
    return
  }
  selected = (index + results.length) % results.length
  for (const [at, element] of Array.from(resultsEl.children).entries()) {
    element.setAttribute('aria-selected', String(at === selected))
  }
  const current = resultsEl.children[selected]
  if (current) {
    queryEl.setAttribute('aria-activedescendant', current.id)
    current.scrollIntoView({ block: 'nearest' })
  }
}

function render() {
  resultsEl.textContent = ''
  emptyEl.hidden = results.length > 0
  for (const [index, result] of results.entries()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'result'
    button.id = `palette-result-${index}`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', 'false')

    const title = document.createElement('span')
    title.className = 'result-title'
    title.textContent = result.title

    const subtitle = document.createElement('span')
    subtitle.className = 'result-subtitle'
    subtitle.textContent = result.subtitle

    button.append(title, subtitle)
    if (result.shortcut) {
      const shortcut = document.createElement('kbd')
      shortcut.className = 'result-shortcut'
      shortcut.textContent = result.shortcut
      button.append(shortcut)
    }
    button.addEventListener('pointermove', () => select(index))
    button.addEventListener('click', () => execute(index, false))
    resultsEl.append(button)
  }
  select(Math.min(selected, Math.max(results.length - 1, 0)))
}

async function refresh() {
  const version = ++requestVersion
  const response = await window.troyPalette.query(queryEl.value)
  if (version !== requestVersion || !response) return
  queryId = String(response.queryId ?? '')
  results = Array.isArray(response.results) ? response.results : []
  selected = 0
  render()
}

function scheduleQuery() {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => void refresh(), 45)
}

async function execute(index, openInNewTab) {
  if (executing || !queryId || !results[index]) return
  executing = true
  try {
    await window.troyPalette.execute(queryId, results[index].id, openInNewTab)
  } finally {
    executing = false
  }
}

queryEl.addEventListener('input', scheduleQuery)
queryEl.addEventListener('keydown', (event) => {
  const next = event.key === 'ArrowDown' || (event.ctrlKey && event.key.toLowerCase() === 'n')
  const previous = event.key === 'ArrowUp' || (event.ctrlKey && event.key.toLowerCase() === 'p')
  if (next) {
    event.preventDefault()
    select(selected + 1)
  } else if (previous) {
    event.preventDefault()
    select(selected - 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void execute(selected, event.shiftKey)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    void window.troyPalette.close()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.activeElement !== queryEl) {
    event.preventDefault()
    void window.troyPalette.close()
  }
})

window.troyPalette.onOpen(() => {
  clearTimeout(queryTimer)
  requestVersion += 1
  queryId = ''
  results = []
  selected = 0
  queryEl.value = ''
  render()
  queryEl.focus()
  void refresh()
})
