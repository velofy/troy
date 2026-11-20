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
 * @property {number} port the CDP port, or 0 when only the agent socket is open
 * @property {string} webSocketDebuggerUrlHint
 * @property {string} httpEndpoint
 * @property {number} pid
 * @property {string} version
 * @property {string} startedAt
 * @property {number} [agentPort] the typed agent socket; absent when not open
 * @property {string} [agentToken] bearer for the agent socket, per launch
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
 * @param {number} options.port the CDP port; 0 when only the agent socket runs
 * @param {number} options.pid
 * @param {string} options.version
 * @param {Date} [options.now]
 * @param {number} [options.agentPort]
 * @param {string} [options.agentToken]
 * @returns {Endpoint}
 */
export function describeEndpoint({ port, pid, version, now = new Date(), agentPort, agentToken }) {
  return {
    port,
    httpEndpoint: port ? `http://127.0.0.1:${port}` : '',
    // The exact ws URL is per-target and changes with the tabs, so point at
    // the list rather than pretending one URL is stable.
    webSocketDebuggerUrlHint: port ? `http://127.0.0.1:${port}/json/list` : '',
    pid,
    version,
    startedAt: now.toISOString(),
    ...(agentPort ? { agentPort } : {}),
    ...(agentToken ? { agentToken } : {}),
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
  // The file carries the agent-socket bearer token: owner-only, always.
  fs.writeFileSync(tmp, body, { mode: 0o600 })
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
 * Is the process that wrote an endpoint still running.
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything. EPERM means the process exists but belongs to another user,
 * which for liveness is the same as alive; only ESRCH means gone.
 *
 * @param {number} pid
 * @param {(pid: number, signal?: number | NodeJS.Signals) => void} [signal]
 * @returns {boolean}
 */
export function pidAlive(pid, signal = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    signal(pid, 0)
    return true
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'
  }
}

/**
 * @typedef {(url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean, body?: { cancel?: () => Promise<unknown> } | null }>} ProbeFetch
 */

/**
 * Confirm Chromium actually bound the debugging port before advertising it.
 *
 * Probes `http://127.0.0.1:${port}/json/version` with a timeout so an
 * unresponsive or unbound port is never written to `agent-endpoint.json`.
 *
 * @param {number} port
 * @param {ProbeFetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function probeEndpoint(port, fetchImpl = fetch, timeoutMs = 1500) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false
  const controller = new AbortController()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  try {
    const response = await Promise.race([
      Promise.resolve().then(() =>
        fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal }),
      ),
      /** @type {Promise<never>} */ (
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('probeEndpoint timed out'))
          }, timeoutMs)
        })
      ),
    ])
    if (response?.body?.cancel) {
      await response.body.cancel().catch(() => {})
    }
    return Boolean(response?.ok)
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read it back, or null when Troy is not accepting agent connections.
 *
 * A file left behind by a crashed Troy is not an advertisement: it points at
 * a port nothing is listening on. The recorded pid is checked for liveness,
 * so a stale file reads as "no endpoint" rather than as a live browser.
 *
 * @param {string} file
 * @param {{ pidAlive?: (pid: number) => boolean }} [options] injected for tests
 * @returns {Endpoint | null}
 */
export function readEndpoint(file, { pidAlive: isAlive = pidAlive } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.port !== 'number') return null
    if (typeof parsed.pid !== 'number' || !isAlive(parsed.pid)) return null
    return parsed
  } catch {
    return null
  }
}
