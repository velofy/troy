// Persistent page memory: what the agent learned about the web, kept.
//
// Every run otherwise starts with amnesia — element refs die with it, and
// nothing remembers that the search box on this site is `input#query` or
// that the "Sign in" button on one page leads to a form on another. This
// store keeps three kinds of facts, all scoped by origin because that is
// the unit of trust the rest of the agent layer already uses:
//
//   pages:    url -> title, when it was last read, a text excerpt
//   elements: origin+selector -> descriptor, plus a verified/failed tally
//   actions:  what was done to which element and where the page ended up,
//             so recall can answer "where does this control take me" as
//             well as "where is it"
//
// Storage is one JSON file, capped and LRU-trimmed, written at most once a
// second. It follows the history rule exactly: the store is written only
// while the setting is on, and turning the setting off deletes the file.

import fs from 'node:fs'
import path from 'node:path'

/** Bounds, so memory stays a working set and never an archive. */
export const MAX_PAGES = 500
export const MAX_ELEMENTS = 2000
export const MAX_ACTIONS = 500
export const MAX_EXCERPT_CHARS = 4000
const FLUSH_MS = 1000

/**
 * @typedef {object} MemoryPage
 * @property {string} url
 * @property {string} origin
 * @property {string} title
 * @property {string} excerpt leading text of the last read, capped
 * @property {number} reads
 * @property {number} lastReadAt epoch ms
 * @property {string} [key] same as url, kept so trimming can address it
 */

/**
 * @typedef {object} MemoryElement
 * @property {string} key origin + selector
 * @property {string} origin
 * @property {string} selector
 * @property {string} signature last descriptor signature seen for it
 * @property {string} tag
 * @property {string} type
 * @property {string} role
 * @property {string} text
 * @property {string} label
 * @property {string} ariaLabel
 * @property {string} name
 * @property {string} placeholder
 * @property {string} pageUrl the url it was last seen on
 * @property {number} verified actions on it that observably worked
 * @property {number} failed actions on it that were refused or failed
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 */

/**
 * @typedef {object} MemoryAction
 * @property {string} kind click | fill | select | navigate
 * @property {string} selector the element acted on, when there was one
 * @property {string} text the element's label/text at the time
 * @property {string} fromUrl
 * @property {string} toUrl where the page ended up afterwards
 * @property {boolean} ok whether the action verified
 * @property {number} at epoch ms
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function originOf(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** @param {string} text */
function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/** @param {string} url */
function pageKey(url) {
  // Query and fragment differences make distinct pages worth remembering,
  // but the same url visited twice must land on one record.
  return String(url ?? '')
}

/**
 * @param {string} file where the JSON store lives
 */
export function createMemory(file) {
  /** @type {{ pages: Map<string, MemoryPage>, elements: Map<string, MemoryElement>, actions: MemoryAction[] }} */
  let store = { pages: new Map(), elements: new Map(), actions: [] }
  let dirty = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let flushTimer = null
  let closed = false

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const p of parsed.pages ?? []) {
        if (p && typeof p.url === 'string' && p.url) store.pages.set(pageKey(p.url), p)
      }
      for (const e of parsed.elements ?? []) {
        if (e && typeof e.key === 'string' && e.key) store.elements.set(e.key, e)
      }
      if (Array.isArray(parsed.actions)) {
        store.actions = parsed.actions
          .filter((/** @type {any} */ a) => a && typeof a.at === 'number')
          .slice(-MAX_ACTIONS)
      }
    }
  } catch {
    // No store yet, or one that does not parse: start empty rather than
    // refuse to boot over a corrupted file.
  }

  function markDirty() {
    dirty = true
    if (flushTimer || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, FLUSH_MS)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  function flush() {
    if (!dirty || closed) return
    dirty = false
    const body = JSON.stringify(
      {
        pages: [...store.pages.values()],
        elements: [...store.elements.values()],
        actions: store.actions,
      },
      null,
      0,
    )
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${body}\n`)
      fs.renameSync(tmp, file)
    } catch {
      // A store that cannot be written is still useful in memory.
    }
  }

  /**
   * Trim a Map to its newest `max` entries by a time field.
   *
   * @param {Map<string, Record<string, any>>} map
   * @param {number} max
   * @param {string} field
   */
  function trimMap(map, max, field) {
    if (map.size <= max) return
    const sorted = [...map.values()].sort((a, b) => a[field] - b[field])
    for (const entry of sorted.slice(0, map.size - max)) map.delete(entry.key ?? entry.url)
  }

  /**
   * Record a page read: upsert the page and every interactive element it
   * reported. Called by the tool layer after a successful page_read.
   *
   * @param {{ url: string, title?: string }} context
   * @param {{ textPreview?: string, interactive?: Array<Record<string, any>> }} result
   */
  function recordRead(context, result) {
    const url = String(context.url ?? '')
    const origin = originOf(url)
    if (!origin) return
    const now = Date.now()
    const existing = store.pages.get(pageKey(url))
    store.pages.set(pageKey(url), {
      url,
      origin,
      title: String(context.title ?? existing?.title ?? ''),
      excerpt: String(result.textPreview ?? existing?.excerpt ?? '').slice(0, MAX_EXCERPT_CHARS),
      reads: (existing?.reads ?? 0) + 1,
      lastReadAt: now,
      key: pageKey(url),
    })

    for (const item of result.interactive ?? []) {
      const selector = String(item.selector ?? '')
      if (!selector) continue
      const key = `${origin} ${selector}`
      const prior = store.elements.get(key)
      store.elements.set(key, {
        key,
        origin,
        selector,
        signature: String(item.signature ?? ''),
        tag: String(item.tag ?? ''),
        type: String(item.type ?? ''),
        role: String(item.role ?? ''),
        text: String(item.text ?? ''),
        label: String(item.label ?? ''),
        ariaLabel: String(item.ariaLabel ?? ''),
        name: String(item.name ?? ''),
        placeholder: String(item.placeholder ?? ''),
        pageUrl: url,
        verified: prior?.verified ?? 0,
        failed: prior?.failed ?? 0,
        firstSeenAt: prior?.firstSeenAt ?? now,
        lastSeenAt: now,
      })
    }

    trimMap(store.pages, MAX_PAGES, 'lastReadAt')
    trimMap(store.elements, MAX_ELEMENTS, 'lastSeenAt')
    markDirty()
  }

  /**
   * Record one attempted action. `item` is the inspected element, outcome
   * says whether it verified, and toUrl records where the tab ended up,
   * which is what turns single actions into remembered paths.
   *
   * @param {{ kind: string, item?: Record<string, any>, fromUrl: string, toUrl: string, ok: boolean }} event
   */
  function recordAction(event) {
    const fromUrl = String(event.fromUrl ?? '')
    const origin = originOf(fromUrl)
    if (!origin) return
    const selector = String(event.item?.selector ?? '')
    const text = String(event.item?.text ?? event.item?.label ?? event.item?.ariaLabel ?? '')
    store.actions.push({
      kind: String(event.kind ?? ''),
      selector,
      text,
      fromUrl,
      toUrl: String(event.toUrl ?? ''),
      ok: Boolean(event.ok),
      at: Date.now(),
    })
    if (store.actions.length > MAX_ACTIONS) store.actions = store.actions.slice(-MAX_ACTIONS)

    if (selector) {
      const key = `${origin} ${selector}`
      const el = store.elements.get(key)
      if (el) {
        if (event.ok) el.verified += 1
        else el.failed += 1
        el.lastSeenAt = Date.now()
      }
    }
    markDirty()
  }

  /**
   * Score one element against query terms. Field weights follow what a
   * person reads: the visible words first, the machine fields second.
   */
  /**
   * @param {MemoryElement} el
   * @param {string[]} terms
   */
  function scoreElement(el, terms) {
    /** @type {Array<[string, number]>} */
    const fields = [
      [el.text, 4],
      [el.label, 4],
      [el.ariaLabel, 4],
      [el.placeholder, 3],
      [el.name, 2],
      [el.role, 2],
      [el.type, 1],
      [el.tag, 1],
    ]
    let score = 0
    for (const term of terms) {
      for (const [value, weight] of fields) {
        if (value && value.toLowerCase().includes(term)) {
          score += weight
          break
        }
      }
    }
    if (score === 0) return 0
    // Elements that verified before outrank ones that failed; recency
    // breaks ties toward what the site looks like now.
    score += el.verified * 2 - el.failed
    return score
  }

  /**
   * Answer "what do I know about this" without re-reading the page.
   * Returns matching elements (with selectors an action can use directly),
   * matching pages, and the recorded paths that lead away from them.
   *
   * @param {string} query
   * @param {{ origin?: string, limit?: number }} [opts]
   */
  function recall(query, opts = {}) {
    const terms = tokens(query)
    if (terms.length === 0) return { elements: [], pages: [], paths: [] }
    const limit = Math.min(Math.max(Number(opts.limit ?? 8), 1), 50)
    const originFilter = opts.origin ? originOf(opts.origin) : ''

    const elements = [...store.elements.values()]
      .filter((el) => !originFilter || el.origin === originFilter)
      .map((el) => ({ el, score: scoreElement(el, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.el.lastSeenAt - a.el.lastSeenAt)
      .slice(0, limit)
      .map(({ el, score }) => ({
        selector: el.selector,
        tag: el.tag,
        type: el.type,
        role: el.role,
        text: el.text,
        label: el.label,
        ariaLabel: el.ariaLabel,
        placeholder: el.placeholder,
        pageUrl: el.pageUrl,
        verified: el.verified,
        failed: el.failed,
        score,
      }))

    const pages = [...store.pages.values()]
      .filter((p) => !originFilter || p.origin === originFilter)
      .map((p) => {
        const hay = `${p.title} ${p.excerpt}`.toLowerCase()
        const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
        return { p, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.p.lastReadAt - a.p.lastReadAt)
      .slice(0, limit)
      .map(({ p, score }) => ({
        url: p.url,
        title: p.title,
        reads: p.reads,
        lastReadAt: p.lastReadAt,
        excerpt: p.excerpt.slice(0, 300),
        score,
      }))

    // The path half of the graph: for matched element selectors, what did
    // acting on them previously lead to.
    const wanted = new Set(elements.map((e) => `${originOf(e.pageUrl)} ${e.selector}`))
    const paths = store.actions
      .filter((a) => wanted.has(`${originOf(a.fromUrl)} ${a.selector}`) && a.toUrl)
      .slice(-20)
      .map((a) => ({ kind: a.kind, text: a.text, fromUrl: a.fromUrl, toUrl: a.toUrl, ok: a.ok }))

    return { elements, pages, paths }
  }

  /**
   * Forget everything, or everything under one origin.
   *
   * @param {string} [origin]
   */
  function forget(origin) {
    const scoped = origin ? originOf(origin) : ''
    if (!scoped) {
      store = { pages: new Map(), elements: new Map(), actions: [] }
    } else {
      for (const [key, p] of store.pages) if (p.origin === scoped) store.pages.delete(key)
      for (const [key, e] of store.elements) if (e.origin === scoped) store.elements.delete(key)
      store.actions = store.actions.filter((a) => originOf(a.fromUrl) !== scoped)
    }
    markDirty()
    return { ok: true, scope: scoped || 'all' }
  }

  /** Remove the store file entirely; the flush-on-close would resurrect it. */
  function erase() {
    closed = true
    if (flushTimer) clearTimeout(flushTimer)
    try {
      fs.rmSync(file)
    } catch {
      // Never written.
    }
  }

  function stats() {
    return {
      pages: store.pages.size,
      elements: store.elements.size,
      actions: store.actions.length,
      file,
    }
  }

  return {
    recordRead,
    recordAction,
    recall,
    forget,
    erase,
    stats,
    flush,
    close() {
      if (flushTimer) clearTimeout(flushTimer)
      flush()
      closed = true
    },
  }
}
