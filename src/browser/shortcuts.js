// The tiles on the new tab page.
//
// These are yours, added by hand. Troy does not watch where you go and
// promote the winners, because that would mean keeping a history, and the
// whole point of the setting next to this one is that it does not.
//
// Stored as a plain JSON array in the profile, keyed by URL so adding the
// same site twice updates the tile rather than making a second one.

import fs from 'node:fs'
import path from 'node:path'

/** More than this and the grid stops being a shortcut and starts being a list. */
export const MAX_SHORTCUTS = 12

/**
 * @typedef {object} Shortcut
 * @property {string} url
 * @property {string} title
 */

/**
 * @param {string} userDataDir
 * @returns {string}
 */
export function shortcutsFile(userDataDir) {
  return path.join(userDataDir, 'shortcuts.json')
}

/**
 * @param {string} file
 * @returns {Shortcut[]}
 */
export function readShortcuts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string')
      .map((entry) => ({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : hostOf(entry.url) }))
      .slice(0, MAX_SHORTCUTS)
  } catch {
    return []
  }
}

/**
 * @param {string} file
 * @param {Shortcut[]} shortcuts
 */
export function writeShortcuts(file, shortcuts) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(shortcuts.slice(0, MAX_SHORTCUTS), null, 2)}\n`)
}

/**
 * Add a tile, or update the title of one already there.
 *
 * Only http and https. A tile that ran `javascript:` when clicked would be
 * the same hole the address bar refuses, reached through the back door.
 *
 * @param {string} file
 * @param {{ url: string, title?: string }} entry
 * @returns {Shortcut[]}
 */
export function addShortcut(file, entry) {
  const url = normalise(entry.url)
  if (!url) return readShortcuts(file)

  const title = entry.title?.trim() || hostOf(url)
  const existing = readShortcuts(file)
  const index = existing.findIndex((s) => s.url === url)

  const next = [...existing]
  if (index >= 0) next[index] = { url, title }
  else next.push({ url, title })

  const trimmed = next.slice(0, MAX_SHORTCUTS)
  writeShortcuts(file, trimmed)
  return trimmed
}

/**
 * @param {string} file
 * @param {string} url
 * @returns {Shortcut[]}
 */
export function removeShortcut(file, url) {
  const target = normalise(url) ?? url
  const next = readShortcuts(file).filter((s) => s.url !== target)
  writeShortcuts(file, next)
  return next
}

/**
 * A tile URL, or null when it is not one Troy will open.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalise(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}
