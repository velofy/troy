// How Claude Code finds the browser.
//
// Troy can be driven from another process over CDP, but only if that process
// knows the port. Making the human copy a port number between two terminals
// is exactly the friction this is supposed to remove, so when the port is
// open Troy writes a small file saying where it is, and deletes it on the
// way out. An agent reads one known path and attaches.
//
// The file records only what is needed to connect. It is not a session
// token and it grants nothing: the port is already open to anything local
// once you ask for it, which is why it stays off unless you do.

import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {object} Endpoint
 * @property {number} port
 * @property {string} webSocketDebuggerUrlHint
 * @property {string} httpEndpoint
 * @property {number} pid
 * @property {string} version
 * @property {string} startedAt
 */

/**
 * Where Troy advertises itself. Alongside the profile, so a second profile
 * cannot silently point an agent at the wrong window.
 *
 * @param {string} userDataDir
 * @returns {string}
 */
export function endpointFile(userDataDir) {
  return path.join(userDataDir, 'agent-endpoint.json')
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {number} options.pid
 * @param {string} options.version
 * @param {Date} [options.now]
 * @returns {Endpoint}
 */
export function describeEndpoint({ port, pid, version, now = new Date() }) {
  return {
    port,
    httpEndpoint: `http://127.0.0.1:${port}`,
    // The exact ws URL is per-target and changes with the tabs, so point at
    // the list rather than pretending one URL is stable.
    webSocketDebuggerUrlHint: `http://127.0.0.1:${port}/json/list`,
    pid,
    version,
    startedAt: now.toISOString(),
  }
}

/**
 * @param {string} file
 * @param {Endpoint} endpoint
 */
export function writeEndpoint(file, endpoint) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `${JSON.stringify(endpoint, null, 2)}\n`
  // Write to a pid-suffixed temp file and rename into place so a reader
  // never sees a half-written endpoint while Troy is starting or restarting.
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

/**
 * Remove the advertisement. Called on quit, so a stale file does not send an
 * agent at a port nothing is listening on.
 *
 * @param {string} file
 */
export function clearEndpoint(file) {
  try {
    fs.rmSync(file)
  } catch {
    // Never written, or already gone.
  }
}

/**
 * Read it back, or null when Troy is not accepting agent connections.
 *
 * @param {string} file
 * @returns {Endpoint | null}
 */
export function readEndpoint(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.port !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
