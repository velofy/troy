// What the omnibox does with what you typed.
//
// This is separated from the window because it is the one place a string a
// human (or an agent) typed turns into something the browser will execute.
// "example.com" should navigate, "how tall is everest" should search, and
// "javascript://%0aalert(document.cookie)" should do neither. Chrome's own
// omnibox refuses javascript: URLs for exactly this reason: pasted into the
// bar of a logged-in tab, that scheme runs in the origin already loaded.
//
// The refusal lives here, in code, rather than in a prompt or a code review
// habit, so it holds for every caller including the agent bridge.

/**
 * @typedef {object} OmniResult
 * @property {'url' | 'search' | 'external' | 'refused' | 'empty'} kind
 * @property {string} [url]     the address to load, for url and search
 * @property {string} [reason]  why it was refused, for refused
 */

/** Schemes the omnibox will load into a tab. */
const NAVIGABLE = new Set(['http', 'https', 'file', 'about'])

/**
 * Schemes that must never come from the address bar. javascript: and data:
 * execute in whatever origin is loaded; the chrome-side ones reach the
 * browser's own internals. Checked before the generic scheme rule below, so
 * "javascript://x/%0aalert(1)" cannot sneak through by looking like a URL.
 */
const REFUSED = new Map([
  ['javascript', 'javascript: URLs run script in the page already open'],
  ['data', 'data: URLs can carry a whole page from the address bar'],
  ['blob', 'blob: URLs are only meaningful inside the page that made them'],
  ['filesystem', 'filesystem: URLs reach the page sandbox directly'],
  ['chrome', 'chrome: is the browser internals, not a web page'],
  ['devtools', 'devtools: is the browser internals, not a web page'],
  ['chrome-extension', 'extension pages are not addressable here'],
])

/** Schemes that belong to another application, handed to the OS. */
const EXTERNAL = new Set(['mailto', 'tel', 'sms', 'facetime', 'msteams', 'zoommtg'])

const SEARCH = 'https://duckduckgo.com/?q='

/**
 * A hostname worth trying as a URL: dot-separated labels ending in something
 * TLD-shaped. "example.com" navigates, "how tall is everest" searches, and a
 * leading slash is read as a path rather than a host so it searches too.
 */
const LIKELY_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}$/i

const LOCAL_HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i

/**
 * Turn omnibox input into an instruction.
 *
 * @param {string} input what the user typed
 * @returns {OmniResult}
 */
export function resolveOmnibox(input) {
  const text = String(input ?? '').trim()
  if (!text) return { kind: 'empty' }

  const scheme = schemeOf(text)
  if (scheme) {
    const refusal = REFUSED.get(scheme)
    if (refusal) return { kind: 'refused', reason: refusal }
    if (EXTERNAL.has(scheme)) return { kind: 'external', url: text }
    if (NAVIGABLE.has(scheme)) {
      if (scheme === 'about' && text.toLowerCase() !== 'about:blank') {
        return { kind: 'refused', reason: 'about: pages other than about:blank are not addressable' }
      }
      return { kind: 'url', url: text }
    }
    // An unknown scheme with an authority ("ssh://host") is somebody else's
    // protocol; let the OS decide rather than searching for it.
    if (text.includes('://')) return { kind: 'external', url: text }
  }

  // Bare hosts. Split the authority off first so "localhost:3000/x?y" and
  // "example.com:8443" are judged on the host alone.
  const authority = text.split(/[/?#]/, 1)[0] ?? ''
  const host = stripPort(authority)

  if (LOCAL_HOST.test(host)) return { kind: 'url', url: `http://${text}` }

  // A space anywhere means it was a sentence, not an address.
  if (!/\s/.test(text) && LIKELY_HOST.test(host)) return { kind: 'url', url: `https://${text}` }

  return { kind: 'search', url: SEARCH + encodeURIComponent(text) }
}

/**
 * The scheme of a URL-shaped string, lowercased, or null.
 *
 * Requires either "//" after the colon or a scheme we know is slashless, so
 * "localhost:3000" is read as a host and port rather than as a URL in the
 * "localhost" scheme.
 *
 * @param {string} text
 * @returns {string | null}
 */
function schemeOf(text) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  if (!match) return null
  const scheme = (match[1] ?? '').toLowerCase()
  const slashless =
    REFUSED.has(scheme) || EXTERNAL.has(scheme) || scheme === 'about' || scheme === 'file'
  if (!slashless && !text.slice(match[0].length).startsWith('//')) return null
  return scheme
}

/**
 * @param {string} authority
 * @returns {string}
 */
function stripPort(authority) {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? authority : authority.slice(0, end + 1)
  }
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return authority
  const port = authority.slice(colon + 1)
  return /^\d+$/.test(port) ? authority.slice(0, colon) : authority
}
