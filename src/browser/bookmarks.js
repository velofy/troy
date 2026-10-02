// Explicit bookmarks: pages the user chose to keep, never inferred from visits.
//
// The store deliberately mirrors history.js: a small bounded JSON file, safe
// defaults for corrupt/missing data, and newest-first deduplication.

import fs from 'node:fs'
import path from 'node:path'

export const MAX_BOOKMARKS = 500

/**
 * @typedef {object} Bookmark
 * @property {string} url
 * @property {string} title
 * @property {string} addedAt ISO timestamp
 */

/** @param {string} userDataDir */
export function bookmarksFile(userDataDir) {
  return path.join(userDataDir, 'bookmarks.json')
}

/**
 * @param {string} file
 * @returns {Bookmark[]}
 */
export function readBookmarks(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url))
      .map((entry) => ({
        url: entry.url,
        title: typeof entry.title === 'string' ? entry.title : '',
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
      }))
      .slice(0, MAX_BOOKMARKS)
  } catch {
    return []
  }
}

/**
 * @param {string} file
 * @param {Bookmark[]} entries
 */
export function writeBookmarks(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(entries.slice(0, MAX_BOOKMARKS), null, 2)}\n`)
}

/**
 * Toggle one HTTP(S) bookmark. Adding moves it to the front; removing keeps
 * every other entry in order.
 *
 * @param {string} file
 * @param {{ url: string, title?: string, now?: Date }} page
 * @returns {{ bookmarked: boolean, entries: Bookmark[] }}
 */
export function toggleBookmark(file, { url, title, now = new Date() }) {
  const address = String(url ?? '').trim()
  const entries = readBookmarks(file)
  if (!/^https?:\/\//i.test(address)) return { bookmarked: false, entries }

  const existing = entries.findIndex((entry) => entry.url === address)
  if (existing !== -1) {
    const next = entries.filter((entry) => entry.url !== address)
    writeBookmarks(file, next)
    return { bookmarked: false, entries: next }
  }

  const next = [
    {
      url: address,
      title: String(title ?? '').trim(),
      addedAt: now.toISOString(),
    },
    ...entries,
  ].slice(0, MAX_BOOKMARKS)
  writeBookmarks(file, next)
  return { bookmarked: true, entries: next }
}

/**
 * @param {Bookmark[]} entries
 * @param {string} url
 */
export function isBookmarked(entries, url) {
  return entries.some((entry) => entry.url === url)
}
