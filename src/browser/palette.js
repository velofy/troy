// Pure command-palette result building. No renderer, filesystem or Electron
// state enters here, which keeps ranking deterministic and cheap to test.

const KIND_PRIORITY = {
  command: 50,
  tab: 40,
  bookmark: 30,
  history: 20,
  navigation: 10,
}

/** @param {unknown} value */
function normalise(value) {
  return String(value ?? '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Exact, prefix, word-prefix, substring, then fuzzy subsequence.
 *
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
export function matchScore(query, text) {
  const q = normalise(query)
  const value = normalise(text)
  if (!q) return 100
  if (!value) return -1
  if (value === q) return 1000
  if (value.startsWith(q)) return 880 - Math.min(value.length - q.length, 80)
  if (value.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) return 780
  const at = value.indexOf(q)
  if (at !== -1) return 680 - Math.min(at, 120)

  let cursor = 0
  let gaps = 0
  for (const character of q) {
    const found = value.indexOf(character, cursor)
    if (found === -1) return -1
    gaps += found - cursor
    cursor = found + 1
  }
  return Math.max(260 - gaps, 1)
}

/**
 * @param {string} query
 * @param {string[]} fields
 */
function bestScore(query, fields) {
  return Math.max(...fields.map((field) => matchScore(query, field)))
}

/**
 * @typedef {object} PaletteResult
 * @property {'command'|'tab'|'bookmark'|'history'|'navigation'} kind
 * @property {string} title
 * @property {string} subtitle
 * @property {string} shortcut
 * @property {number} score
 * @property {Record<string, unknown>} payload
 */

/**
 * @param {{
 *   query: string,
 *   commands: Array<{ id: string, title: string, category: string, keywords?: string[], shortcut?: string, enabled: boolean }>,
 *   tabs: Array<{ id: number, title: string, url: string, active?: boolean }>,
 *   bookmarks?: Array<{ title: string, url: string }>,
 *   history?: Array<{ title: string, url: string, visitedAt?: string }>,
 *   resolve: (input: string) => { kind: string, url?: string, reason?: string },
 *   limit?: number,
 * }} input
 * @returns {PaletteResult[]}
 */
export function buildPaletteResults(input) {
  const query = String(input.query ?? '').slice(0, 256).trim()
  const limit = Math.max(1, Math.min(Number(input.limit ?? 12), 50))
  /** @type {PaletteResult[]} */
  const results = []
  const seenUrls = new Set()

  for (const command of input.commands) {
    if (!command.enabled) continue
    const score = bestScore(query, [command.title, command.category, ...(command.keywords ?? [])])
    if (score < 0) continue
    results.push({
      kind: 'command',
      title: command.title,
      subtitle: command.category,
      shortcut: command.shortcut ?? '',
      score: score + KIND_PRIORITY.command,
      payload: { commandId: command.id },
    })
  }

  for (const tab of input.tabs) {
    const score = bestScore(query, [tab.title, tab.url])
    if (score < 0) continue
    results.push({
      kind: 'tab',
      title: tab.title || tab.url || 'Untitled tab',
      subtitle: tab.active ? `Current tab · ${tab.url}` : tab.url,
      shortcut: '',
      score: score + KIND_PRIORITY.tab + (tab.active ? 5 : 0),
      payload: { tabId: tab.id },
    })
    if (tab.url) seenUrls.add(tab.url)
  }

  for (const bookmark of input.bookmarks ?? []) {
    if (!bookmark.url || seenUrls.has(bookmark.url)) continue
    const score = bestScore(query, [bookmark.title, bookmark.url])
    if (score < 0) continue
    results.push({
      kind: 'bookmark',
      title: bookmark.title || bookmark.url,
      subtitle: `Bookmark · ${bookmark.url}`,
      shortcut: '',
      score: score + KIND_PRIORITY.bookmark,
      payload: { url: bookmark.url },
    })
    seenUrls.add(bookmark.url)
  }

  for (const entry of input.history ?? []) {
    if (!entry.url || seenUrls.has(entry.url)) continue
    const score = bestScore(query, [entry.title, entry.url])
    if (score < 0) continue
    results.push({
      kind: 'history',
      title: entry.title || entry.url,
      subtitle: `History · ${entry.url}`,
      shortcut: '',
      score: score + KIND_PRIORITY.history,
      payload: { url: entry.url },
    })
    seenUrls.add(entry.url)
  }

  if (query) {
    const resolved = input.resolve(query)
    if (resolved.kind === 'url' || resolved.kind === 'search') {
      const title = resolved.kind === 'search' ? `Search for “${query}”` : `Open ${query}`
      results.push({
        kind: 'navigation',
        title,
        subtitle: resolved.url ?? '',
        shortcut: 'Enter',
        score: 120 + KIND_PRIORITY.navigation,
        payload: { input: query },
      })
    }
  }

  return results
    .sort((a, b) => b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.title.localeCompare(b.title))
    .slice(0, limit)
}
