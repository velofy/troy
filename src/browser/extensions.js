// Chrome extensions, loaded from a folder you control.
//
// Troy exists to be driven by an agent, and the things that make a browser
// worth testing in are mostly extensions: a request blocker, a framework
// inspector, a recorder. Chromium can run them, so Troy should let you load
// them rather than pretending the browser is only the tabs.
//
// Unpacked only, from a directory the user owns. There is no store, no
// remote install and no auto-update, because "the browser silently fetched
// and ran code" is exactly the property an agent-facing browser should not
// have. You put a folder in, Troy loads it, and it tells you what it loaded.
//
// Electron implements a useful subset of the extension APIs rather than all
// of them, so an extension that needs something unimplemented will report
// that itself; loading is still the right behaviour.

import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {object} ExtensionManifest
 * @property {string} name
 * @property {string} version
 * @property {number} manifestVersion
 */

/**
 * @typedef {object} LoadResult
 * @property {string} dir
 * @property {boolean} ok
 * @property {string} name
 * @property {string} [id]
 * @property {string} [error]
 */

/**
 * Every directory under `root` that actually looks like an unpacked
 * extension. A folder without a manifest is somebody's notes, not an
 * extension, and trying to load it would only produce a confusing error.
 *
 * @param {string} root
 * @returns {string[]} absolute paths, in a stable order
 */
export function findExtensions(root) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
    .sort()
}

/**
 * What an unpacked extension says about itself, or null if the manifest is
 * missing or not JSON.
 *
 * @param {string} dir
 * @returns {ExtensionManifest | null}
 */
export function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : path.basename(dir),
      version: typeof parsed.version === 'string' ? parsed.version : '0',
      manifestVersion: Number(parsed.manifest_version ?? 0),
    }
  } catch {
    return null
  }
}

/**
 * Load every extension under `root` into a session.
 *
 * One extension failing must not stop the others: a browser that refuses to
 * start because one folder is broken is worse than a browser missing one
 * extension, so each result is reported and the loop continues.
 *
 * @param {{ extensions: { loadExtension(path: string, options?: object): Promise<{ id: string, name: string }> } }} session
 * @param {string} root
 * @returns {Promise<LoadResult[]>}
 */
export async function loadExtensions(session, root) {
  /** @type {LoadResult[]} */
  const results = []
  for (const dir of findExtensions(root)) {
    const manifest = readManifest(dir)
    const fallbackName = manifest?.name ?? path.basename(dir)
    try {
      // allowFileAccess stays off: an extension that can read file:// URLs
      // can read the disk, and nothing here asked for that.
      const loaded = await session.extensions.loadExtension(dir, { allowFileAccess: false })
      results.push({ dir, ok: true, name: loaded.name || fallbackName, id: loaded.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ dir, ok: false, name: fallbackName, error: message })
    }
  }
  return results
}

/**
 * A one-line summary for the log, so a failed extension is visible without
 * anyone having to go looking for it.
 *
 * @param {LoadResult[]} results
 * @returns {string}
 */
export function summarise(results) {
  if (results.length === 0) return 'no extensions installed'
  const loaded = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const parts = [`${loaded.length} extension${loaded.length === 1 ? '' : 's'} loaded`]
  if (loaded.length) parts.push(loaded.map((r) => r.name).join(', '))
  if (failed.length) {
    parts.push(`${failed.length} failed: ${failed.map((r) => `${r.name} (${r.error})`).join('; ')}`)
  }
  return parts.join(': ')
}
