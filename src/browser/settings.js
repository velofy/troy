// What Troy remembers, and what it deliberately does not.
//
// The default that matters here is `rememberHistory: false`. A browser meant
// to be driven by an agent, on a profile that is signed into real accounts,
// should not start keeping a list of everywhere you went unless you asked
// for one. So the list does not exist until you turn it on, and turning it
// off again throws away what was collected.
//
// Settings live in one small JSON file next to the profile. Unknown keys in
// the file are preserved rather than dropped, so a newer Troy's settings
// survive being opened by an older one.

import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {object} Settings
 * @property {boolean} rememberHistory
 * @property {boolean} blockTrackers
 * @property {string} searchEngine
 */

/** @returns {Settings} */
export function defaults() {
  return {
    // Off. See the note at the top of this file.
    rememberHistory: false,
    blockTrackers: true,
    searchEngine: 'google',
  }
}

/**
 * @param {string} userDataDir
 * @returns {string}
 */
export function settingsFile(userDataDir) {
  return path.join(userDataDir, 'settings.json')
}

/**
 * Read settings, falling back to defaults for anything missing or wrong.
 * A corrupt settings file must not stop the browser starting.
 *
 * @param {string} file
 * @returns {Settings}
 */
export function readSettings(file) {
  const base = defaults()
  /** @type {Record<string, unknown>} */
  let stored
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return base
  }
  if (!stored || typeof stored !== 'object') return base

  return {
    ...stored,
    rememberHistory: typeof stored.rememberHistory === 'boolean' ? stored.rememberHistory : base.rememberHistory,
    blockTrackers: typeof stored.blockTrackers === 'boolean' ? stored.blockTrackers : base.blockTrackers,
    searchEngine: typeof stored.searchEngine === 'string' && stored.searchEngine ? stored.searchEngine : base.searchEngine,
  }
}

/**
 * Merge a change in and write it back, keeping keys this version does not
 * know about.
 *
 * @param {string} file
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
export function writeSettings(file, patch) {
  const next = { ...readSettings(file), ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
