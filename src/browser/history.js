// Where Troy went, when you asked it to remember.
//
// Off by default. When rememberHistory is false this file is not written to
// and any existing file is cleared when you turn the setting off again.
// Nothing here feeds the new tab tiles: shortcuts are added by hand on
// purpose, so a browsing list never silently becomes a surveillance grid.

import fs from 'node:fs'
import path from 'node:path'

/** Enough to be useful in the omnibox later, not enough to become an archive. */
export const MAX_HISTORY = 500

/**
 * @typedef {object} HistoryEntry
 * @property {string} url
 * @property {string} title
 * @property {string} visitedAt ISO timestamp
 */

/**
 * @param {string} userDataDir
 * @returns {string}
 */
export function historyFile(userDataDir) {
  return path.join(userDataDir, 'history.json')
}

/**
 * @param {string} file
 * @returns {HistoryEntry[]}
 */
export function readHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && entry.url)
      .map((entry) => ({
        url: entry.url,
        title: typeof entry.title === 'string' ? entry.title : '',
        visitedAt: typeof entry.visitedAt === 'string' ? entry.visitedAt : '',
      }))
      .slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

/**
 * @param {string} file
 * @param {HistoryEntry[]} entries
 */
export function writeHistory(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(entries.slice(0, MAX_HISTORY), null, 2)}\n`)
}

/**
 * Forget every recorded visit.
 *
 * @param {string} file
 */
export function clearHistory(file) {
  try {
    fs.rmSync(file)
  } catch {
    // Never written, or already gone.
  }
}

/**
 * Record one visit at the front of the list. The newest entry wins when the
 * same url is visited again, so reloads bump rather than duplicate.
 *
 * @param {string} file
 * @param {{ url: string, title?: string, now?: Date }} visit
 * @returns {HistoryEntry[]}
 */
export function recordVisit(file, { url, title, now = new Date() }) {
  const text = String(url ?? '').trim()
  if (!text) return readHistory(file)

  const entry = {
    url: text,
    title: String(title ?? '').trim(),
    visitedAt: now.toISOString(),
  }

  const existing = readHistory(file).filter((item) => item.url !== text)
  const next = [entry, ...existing].slice(0, MAX_HISTORY)
  writeHistory(file, next)
  return next
}
