// The tool layer: everything an agent may do to this tab, written down.
//
// The contract, enforced in code rather than asked for politely:
// - Inspection happens before action, and every refusal fires on the
//   inspection result, before any script that could change the page runs.
// - Ambiguity is refused, never guessed at. A selector matching two nodes
//   is an error, not a coin flip.
// - The omnibox's refusal rules apply here too, from the same resolver.
// - Results are size-capped with an explicit truncation marker, because
//   shipping megabytes of page into a model context is its own accident.
//
// Tools are marked gated (navigate, click, fill, select) or free (read,
// text, scrape). The application supplies deterministic policy authorization;
// legacy CLI callers may still supply their own gate around this layer.

import { ELEMENT_DESCRIPTOR_EXPRESSION, SELECTOR_FOR_EXPRESSION } from './element-descriptor.js'

/** Result payloads larger than this are cut and flagged. */
export const MAX_TOOL_RESULT_CHARS = 20000
export const MAX_INTERACTIVE_ELEMENTS = 300
export const MAX_FIND_RESULTS = 15
export const MAX_ACT_OPS = 20

/** Text that reads like committing something. Clicking one of these is how
 * an order gets placed, so the answer is no before any heuristic runs. */
const SUBMIT_PATTERN = /submit|commit|place (the )?order|checkout|pay\b|purchase|send\b|confirm/i

/**
 * One interactive element as the inspection expression reported it.
 *
 * @typedef {object} InspectItem
 * @property {string} tag
 * @property {string} type
 * @property {string} name
 * @property {string} text
 * @property {string} value
 * @property {boolean} disabled
 * @property {boolean} defaultSubmit
 * @property {boolean} editable
 * @property {number | null} maxLength
 * @property {boolean} readOnly
 */

/** @typedef {{ url: string, title: string, visibleFields: number, fieldCount: number, fields: Array<{ k: string, v: string }>, marked: number, textLen: number }} PageSnapshot */

/** @typedef {{ name: string, description: string, gated: boolean, input: Record<string, any> }} ToolSpec */

/**
 * Cut an oversized payload down and say so.
 *
 * @template T
 * @param {T} result
 * @returns {T}
 */
function capResult(result) {
  const text = JSON.stringify(result)
  if (!text || text.length <= MAX_TOOL_RESULT_CHARS) return result
  // Wide margin: the note and the wrapper keys also count against the cap.
  const budget = MAX_TOOL_RESULT_CHARS - 600
  // Objects get a string field cut to fit; strings are cut directly.
  if (typeof result === 'object' && result !== null && 'content' in result) {
    return {
      ...result,
      content: String(result.content).slice(0, budget),
      truncated: true,
      note: `result was longer than ${MAX_TOOL_RESULT_CHARS} characters and was truncated`,
    }
  }
  return /** @type {T} */ ({
    content: text.slice(0, budget),
    truncated: true,
    note: `result was longer than ${MAX_TOOL_RESULT_CHARS} characters and was truncated to a JSON preview`,
  })
}

/** Expressions the click and fill tools evaluate against the live page. */

const INSPECT_EXPRESSION = `(expr) => (() => {
  const scope = expr.within ? document.querySelector(expr.within) : document
  if (expr.within && !scope) return JSON.stringify({ scopeMissing: expr.within })
  let matches
  try { matches = scope.querySelectorAll(expr.selector) } catch { return JSON.stringify({ count: 0, items: [], badSelector: true }) }
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const items = Array.from(matches).slice(0, 5).map(describe)
  return JSON.stringify({ count: matches.length, items })
})()`

const SNAPSHOT_EXPRESSION = `(() => {
  const body = document.body
  const fields = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 })
    .slice(0, 50)
    .map((el) => ({ k: el.name || el.id || '', v: String(el.value ?? '') }))
  const marked = Array.from(document.querySelectorAll('[data-troy-marked], .open, [aria-expanded="true"]')).length
  return JSON.stringify({
    url: location.href,
    title: document.title,
    visibleFields: fields.length,
    fieldCount: document.querySelectorAll('input:not([type=hidden]), textarea').length,
    fields,
    marked,
    textLen: body ? (body.innerText || '').length : 0,
  })
})()`

const CLICK_EXPRESSION = `(sel) => (() => {
  const el = document.querySelector(sel)
  if (!el) return JSON.stringify({ acted: false, reason: 'gone' })
  el.scrollIntoView({ block: 'center' })
  el.click()
  return JSON.stringify({ acted: true })
})()`

const FILL_EXPRESSION = `(cmd) => (() => {
  const el = document.querySelector(cmd.selector)
  if (!el) return JSON.stringify({ acted: false, reason: 'gone' })
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if (el.isContentEditable) {
    el.textContent = cmd.text
  } else {
    el.value = cmd.text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  el.blur()
  return JSON.stringify({ acted: true })
})()`

const READBACK_EXPRESSION = `(sel) => (() => {
  const el = document.querySelector(sel)
  if (!el) return ''
  return el.isContentEditable ? (el.innerText || '').trim() : String(el.value ?? '')
})()`

// A dropdown is matched by its option label first and its value second,
// because models and people both speak in labels. The act reports the
// canonical label it landed on so the read-back has something honest to
// be compared against.
const SELECT_EXPRESSION = `(cmd) => (() => {
  const el = document.querySelector(cmd.selector)
  if (!el) return JSON.stringify({ acted: false, reason: 'gone' })
  const wanted = String(cmd.value).trim().toLowerCase()
  const options = Array.from(el.options || [])
  const match = options.find((o) => o.value.toLowerCase() === wanted) ||
    options.find((o) => (o.textContent || '').trim().toLowerCase() === wanted)
  if (!match) {
    return JSON.stringify({
      acted: false,
      reason: 'no such option',
      options: options.slice(0, 30).map((o) => ({ value: o.value, label: (o.textContent || '').trim() })),
    })
  }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
  return JSON.stringify({ acted: true, value: match.value, label: (match.textContent || '').trim() })
})()`

const SELECT_READBACK_EXPRESSION = `(sel) => (() => {
  const el = document.querySelector(sel)
  if (!el) return ''
  const opt = el.selectedOptions && el.selectedOptions[0]
  return opt ? (opt.textContent || '').trim() : String(el.value ?? '')
})()`

// A targeted element query: the same interactive set page_read lists, scored
// in-page against the query terms so the agent pays for the five matches it
// asked for rather than the five hundred elements it did not. Returns raw
// descriptors with selectors; the caller registers refs from them.
const FIND_EXPRESSION = `(cmd) => (() => {
  const terms = String(cmd.q || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
  if (!terms.length) return JSON.stringify({ items: [], scanned: 0 })
  const selectorFor = ${SELECTOR_FOR_EXPRESSION}
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const scored = []
  let scanned = 0
  for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="searchbox"], [role="textbox"], [role="combobox"], summary')) {
    scanned += 1
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    const d = describe(el)
    const fields = [
      [d.text, 4],
      [d.label, 4],
      [d.ariaLabel, 4],
      [d.placeholder, 3],
      [d.name, 2],
      [d.role, 2],
      [d.type, 1],
      [d.tag, 1],
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
    if (score > 0) scored.push({ score, selector: selectorFor(el), item: d })
  }
  scored.sort((a, b) => b.score - a.score)
  return JSON.stringify({
    scanned,
    items: scored.slice(0, ${MAX_FIND_RESULTS}).map((entry) => ({ selector: entry.selector, ...entry.item })),
  })
})()`

// Reading one element's own words. The count is checked here, in the page,
// because picking the first of many matches silently is exactly the guess
// this layer refuses to make. Form controls carry their content in .value,
// not innerText — except password fields, which are never read back.
const TEXT_EXPRESSION = `(sel) => (() => {
  let matches
  try { matches = document.querySelectorAll(sel) } catch { return JSON.stringify({ badSelector: true }) }
  if (matches.length !== 1) return JSON.stringify({ count: matches.length, text: '' })
  const el = matches[0]
  const r = el.getBoundingClientRect()
  const tag = el.tagName
  const isPassword = tag === 'INPUT' && String(el.type || '').toLowerCase() === 'password'
  const isControl = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  return JSON.stringify({
    count: 1,
    text: isPassword ? '[password field]' : isControl ? String(el.value ?? '') : (el.innerText || '').trim(),
    visible: r.width > 0 && r.height > 0,
  })
})()`

/**
 * @typedef {object} ToolHost
 * @property {() => Promise<unknown>} read full page facts for the active tab
 * @property {() => Promise<unknown>} [readVisual] fused DOM/OCR read
 * @property {(expression: string) => Promise<unknown>} evaluate run JS in the page
 * @property {(input: string) => { kind: string, url?: string, reason?: string }} resolve omnibox resolver
 * @property {(url: string) => Promise<unknown>} load navigate the tab
 * @property {(cmd: string, args: string[]) => Promise<{ code?: number, stdout?: string, stderr?: string } | { missing: string }>} exec run a subprocess
 * @property {() => Promise<void>} settle wait for the page to stop moving
 * @property {() => { tabId: number, url: string, epoch: number }} [context] current element capability context
 * @property {() => void} [invalidate] invalidate the page/document epoch
 */

/**
 * @param {ToolHost} host
 * @param {{
 *   elements?: import('./elements.js').ElementRegistry,
 *   authorize?: (request: { name: string, item?: Record<string, any>, targetUrl?: string }) => import('./policy.js').PolicyDecision,
 *   includeScrape?: boolean,
 *   memory?: { recordRead?: (context: any, result: any) => void, recordAction?: (event: any) => void, recall?: (query: string, opts?: any) => any },
 *   signal?: AbortSignal,
 * }} options
 * @returns {{ specs: ToolSpec[], run: (name: string, args?: any) => Promise<Record<string, unknown>> }}
 */
export function createTools(host, options = {}) {
  function assertNotAborted() {
    if (!options.signal?.aborted) return
    const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('the agent run was cancelled')
    error.name = 'AbortError'
    throw error
  }

  /** @param {ReturnType<NonNullable<typeof options.authorize>>} decision */
  function refusal(decision) {
    if (decision.allowed) return null
    return {
      error: decision.reason,
      blocked: true,
      boundary: decision.status === 'boundary',
      code: decision.code,
      origin: decision.origin,
    }
  }

  /**
   * Evaluate and parse a JSON-returning expression. Over CDP the page hands
   * back a JSON string; scripted hosts in tests hand objects straight
   * through, so both spellings are accepted at this one seam.
   */
  async function evalJson(/** @type {string} */ expression) {
    assertNotAborted()
    const raw = await host.evaluate(expression)
    assertNotAborted()
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw
  }

  /**
   * The previous read, kept so `since: true` can answer "what changed"
   * instead of re-shipping the whole inventory. Elements are compared by
   * selector+signature, which is the identity the ref contract uses.
   *
   * @type {{ url: string, textPreview: string, bySelector: Map<string, Record<string, any>> } | null}
   */
  let lastRead = null

  /**
   * @param {Record<string, any>} result the normalised page_read payload
   * @param {Array<Record<string, any>>} rawInteractive selector-bearing items
   */
  function diffRead(result, rawInteractive) {
    if (!lastRead || lastRead.url !== result.url) return null
    const current = new Map(rawInteractive.map((item) => [String(item.selector ?? ''), item]))
    const added = []
    const changed = []
    for (const [selector, item] of current) {
      const prior = lastRead.bySelector.get(selector)
      if (!prior) added.push(item)
      else if (String(prior.signature ?? '') !== String(item.signature ?? '')) changed.push(item)
    }
    const removed = [...lastRead.bySelector.keys()].filter((selector) => !current.has(selector))
    return {
      delta: true,
      added,
      changed,
      removedCount: removed.length,
      addedCount: added.length,
      changedCount: changed.length,
      textChanged: lastRead.textPreview !== result.textPreview,
      previousPreviewLength: lastRead.textPreview.length,
    }
  }

  async function pageRead(/** @type {any} */ args) {
    assertNotAborted()
    const result = /** @type {Record<string, any>} */ (await host.read())
    const rawInteractive = Array.isArray(result.interactive) ? [...result.interactive] : []
    if (Array.isArray(result.interactive)) {
      const reported = result.interactive.length
      result.interactive = result.interactive.slice(0, MAX_INTERACTIVE_ELEMENTS)
      if (options.elements && host.context) {
        result.interactive = options.elements.register(result.interactive, host.context())
      }
      while (result.interactive.length > 1 && JSON.stringify(result).length > MAX_TOOL_RESULT_CHARS) {
        result.interactive = result.interactive.slice(0, Math.ceil(result.interactive.length / 2))
      }
      if (reported > result.interactive.length || result.interactiveTruncated) {
        result.interactiveTruncated = true
        result.note = `interactive elements were limited to ${result.interactive.length}; refine the page before acting on controls not listed`
      }
    }
    options.memory?.recordRead?.(
      { url: String(result.url ?? host.context?.().url ?? ''), title: String(result.title ?? '') },
      { textPreview: result.textPreview, interactive: rawInteractive.slice(0, MAX_INTERACTIVE_ELEMENTS) },
    )
    if (args?.since) {
      const delta = diffRead(result, rawInteractive.slice(0, MAX_INTERACTIVE_ELEMENTS))
      if (delta) {
        lastRead = {
          url: String(result.url ?? ''),
          textPreview: String(result.textPreview ?? ''),
          bySelector: new Map(
            rawInteractive.slice(0, MAX_INTERACTIVE_ELEMENTS).map((item) => [String(item.selector ?? ''), item]),
          ),
        }
        return capResult({ url: result.url, title: result.title, ...delta })
      }
    }
    lastRead = {
      url: String(result.url ?? ''),
      textPreview: String(result.textPreview ?? ''),
      bySelector: new Map(
        rawInteractive.slice(0, MAX_INTERACTIVE_ELEMENTS).map((item) => [String(item.selector ?? ''), item]),
      ),
    }
    return capResult(result)
  }

  async function pageReadVisual() {
    if (!host.readVisual) return { error: 'visual page reading is unavailable in this host' }
    assertNotAborted()
    return capResult(await host.readVisual())
  }

  async function pageNavigate(/** @type {any} */ args) {
    const resolved = host.resolve(String(args.url ?? ''))
    switch (resolved.kind) {
      case 'empty':
        return { error: 'no address given' }
      case 'refused':
        return { error: `refused by the browser's own rules: ${resolved.reason ?? 'not navigable'}` }
      case 'external':
        return { error: `${resolved.url} opens in another application, which the agent may not launch` }
      case 'url':
      case 'search': {
        if (options.authorize) {
          const denied = refusal(options.authorize({ name: 'page_navigate', targetUrl: resolved.url ?? '' }))
          if (denied) return denied
        }
        assertNotAborted()
        const fromUrl = String(host.context?.().url ?? '')
        await host.load(resolved.url ?? '')
        await host.settle()
        options.elements?.invalidate()
        host.invalidate?.()
        options.memory?.recordAction?.({ kind: 'navigate', fromUrl, toUrl: resolved.url ?? '', ok: true })
        return { ok: true, kind: resolved.kind, url: resolved.url }
      }
      default:
        return { error: `unresolvable address (${resolved.kind})` }
    }
  }

  /**
   * Shared inspection: resolve the selector, refuse ambiguity, then hand the
   * single match back. Every refusal here happens before anything that could
   * change the page.
   */
  async function inspectOne(/** @type {any} */ args) {
    let selector = String(args.selector ?? '')
    let expected = null
    if (options.elements) {
      if (!host.context) return { error: 'this host cannot resolve element references' }
      const resolved = options.elements.resolve(args.ref, host.context())
      if ('error' in resolved) return resolved
      selector = resolved.selector
      expected = resolved.item
    }
    const inspection = await evalJson(
      `(${INSPECT_EXPRESSION})(${JSON.stringify({ selector, within: options.elements ? undefined : args.within })})`,
    )
    const label = options.elements ? String(args.ref ?? 'that element') : selector
    if (inspection.scopeMissing) {
      return { error: `the scope container ${inspection.scopeMissing} matched nothing; refusing to act outside it` }
    }
    if (inspection.badSelector) {
      return { error: `${label} no longer has a usable selector; read the page again` }
    }
    if (inspection.count === 0) {
      return { error: `nothing matched ${label}; refusing to guess` }
    }
    if (inspection.count > 1) {
      const summaries = inspection.items
        .map((/** @type {InspectItem} */ item) => `<${item.tag}> ${item.text || item.name || item.type}`.trim())
        .join('; ')
      return { error: `${inspection.count} elements matched ${label}: ${summaries}. Refusing to choose among them; read the page again.` }
    }
    const current = inspection.items[0]
    if (expected?.signature && current.signature !== expected.signature) {
      options.elements?.invalidate()
      return { error: `${label} now points to a different control; read the page again` }
    }
    return { item: current, selector }
  }

  async function pageClick(/** @type {any} */ args) {
    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    if (item.disabled) return { error: `that control is disabled` }
    if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_click', item }))
      if (denied) return denied
    }
    if (SUBMIT_PATTERN.test(item.text)) {
      return { error: `"${item.text}" reads like a submit or commit action, which is always yours to click` }
    }
    if (item.defaultSubmit) {
      return { error: `that button would submit its form, which is always yours to click` }
    }

    const before = await evalJson(SNAPSHOT_EXPRESSION)
    assertNotAborted()
    await host.evaluate(`(${CLICK_EXPRESSION})(${JSON.stringify(selector)})`)
    await host.settle()
    const after = await evalJson(SNAPSHOT_EXPRESSION)
    // Refs survive a same-document action: inspection re-verifies the
    // selector AND signature before every act, so a moved element is refused
    // at resolve time, not clicked blindly. Navigation still invalidates via
    // the document epoch. pageChanged tells the model the inventory may have
    // grown without making it pay a re-read to learn that it did.
    const reasons = diffSnapshots(before, after)
    options.memory?.recordAction?.({
      kind: 'click',
      item: { ...item, selector },
      fromUrl: String(before.url ?? ''),
      toUrl: String(after.url ?? ''),
      ok: reasons.length > 0,
    })

    if (options.authorize && host.context) {
      const boundary = refusal(options.authorize({ name: 'page_navigate', targetUrl: host.context().url }))
      if (boundary) return boundary
    }
    if (reasons.length === 0) {
      return {
        ok: false,
        changed: false,
        note: 'NOT VERIFIED: the click ran but nothing observably changed on the page',
        reasons,
      }
    }
    return { ok: true, changed: true, pageChanged: true, reasons }
  }

  async function pageFill(/** @type {any} */ args) {
    const text = String(args.text ?? '')
    if (!text.trim()) {
      return { error: 'refusing to fill an empty answer' }
    }
    if (/[\u2013\u2014]/.test(text)) {
      return { error: 'the answer contains an em-dash or en-dash; use plain hyphens or commas' }
    }

    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    if (item.type === 'password') return { error: 'password fields are never filled by the agent' }
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_fill', item }))
      if (denied) return denied
    }
    // Text-input-ness is judged from what the element IS, not from a single
    // reported flag: an input of a text-like type, a textarea, or anything
    // contenteditable counts. A bare div does not.
    const textLikeTypes = ['text', 'email', 'url', 'tel', 'search', 'number', 'date', 'time']
    const isTextInput =
      item.tag === 'textarea' ||
      item.editable === true ||
      (item.tag === 'input' && (textLikeTypes.includes(item.type) || item.type === ''))
    if (!isTextInput) {
      return { error: `<${item.tag}> is not a text input, so there is nothing to fill` }
    }
    if (item.maxLength !== null && text.length > item.maxLength) {
      return { error: `the answer is ${text.length} characters but the field allows ${item.maxLength}; refusing to write an answer that would be silently truncated` }
    }

    assertNotAborted()
    await host.evaluate(`(${FILL_EXPRESSION})(${JSON.stringify({ selector, text })})`)
    await host.settle()
    const rawBack = await host.evaluate(`(${READBACK_EXPRESSION})(${JSON.stringify(selector)})`)
    const landed = typeof rawBack === 'string' ? rawBack : String(rawBack ?? '')
    options.memory?.recordAction?.({
      kind: 'fill',
      item: { ...item, selector },
      fromUrl: String(host.context?.().url ?? ''),
      toUrl: String(host.context?.().url ?? ''),
      ok: landed === text,
    })
    if (landed !== text) {
      return {
        ok: false,
        note: `MISMATCH: wrote ${text.length} characters, read back "${landed.slice(0, 120)}"; the page rewrote or dropped the value`,
      }
    }
    return { ok: true, changed: true, pageChanged: true }
  }

  async function pageScrape(/** @type {any} */ args) {
    const url = String(args.url ?? '')
    if (!/^https:\/\//i.test(url)) {
      return { error: `only https: addresses are scraped; ${url.split(':')[0] || 'that scheme'} is refused` }
    }
    const outcome = await host.exec('python3', ['-m', 'curl_reap.cli', 'get', url])
    if ('missing' in outcome) {
      return { error: `curl_reap is not available (${outcome.missing}); install it with pip install curl-reap` }
    }
    if (outcome.code !== 0) {
      return { error: `curl_reap exited ${outcome.code}: ${(outcome.stderr ?? '').trim().slice(0, 500)}` }
    }
    return capResult({ ok: true, url, content: outcome.stdout ?? '', command: ['python3', '-m', 'curl_reap.cli', 'get', url] })
  }

  async function pageSelect(/** @type {any} */ args) {
    const value = String(args.value ?? '').trim()
    if (!value) {
      return { error: 'refusing to select nothing; give the option label or its value' }
    }

    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    if (item.disabled) return { error: 'that control is disabled' }
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_select', item }))
      if (denied) return denied
    }
    if (item.tag !== 'select') {
      return { error: `<${item.tag}> is not a dropdown; page_select only operates <select> elements` }
    }

    const act = await evalJson(`(${SELECT_EXPRESSION})(${JSON.stringify({ selector, value })})`)
    if (!act.acted) {
      const listed = (act.options ?? []).map((/** @type {any} */ o) => o.label || o.value).join(', ')
      return { error: `no option matched "${value}". The options are: ${listed}` }
    }
    await host.settle()
    const rawBack = await host.evaluate(`(${SELECT_READBACK_EXPRESSION})(${JSON.stringify(selector)})`)
    const landed = typeof rawBack === 'string' ? rawBack : String(rawBack ?? '')
    options.memory?.recordAction?.({
      kind: 'select',
      item: { ...item, selector },
      fromUrl: String(host.context?.().url ?? ''),
      toUrl: String(host.context?.().url ?? ''),
      ok: landed === act.label,
    })
    if (landed !== act.label) {
      return {
        ok: false,
        note: `MISMATCH: asked for "${act.label}" but the selection now reads "${landed.slice(0, 120)}"; the page rewrote it`,
      }
    }
    return { ok: true, changed: true, pageChanged: true, selected: act.label, value: act.value }
  }

  async function pageText(/** @type {any} */ args) {
    let selector = String(args.selector ?? '').trim()
    let label = selector
    if (options.elements) {
      if (!host.context) return { error: 'this host cannot resolve element references' }
      const resolved = options.elements.resolve(args.ref, host.context())
      if ('error' in resolved) return resolved
      selector = resolved.selector
      label = String(args.ref ?? '')
    }
    if (!selector) return { error: options.elements ? 'no element reference given' : 'no selector given' }
    const read = await evalJson(`(${TEXT_EXPRESSION})(${JSON.stringify(selector)})`)
    if (read.badSelector) {
      return { error: options.elements ? `${label} is no longer usable; read the page again` : `${label} is not a usable selector` }
    }
    if (read.count === 0) {
      return { error: `nothing matched ${label}; refusing to guess` }
    }
    if (read.count > 1) {
      return { error: `${read.count} elements matched ${label}. Refusing to choose among them; read the page again.` }
    }
    return {
      ok: true,
      text: read.text,
      visible: read.visible,
      note: read.visible ? undefined : 'the element exists but is not visible on screen',
    }
  }

  /** What changed between two snapshots, in words a person can audit. */
  function diffSnapshots(/** @type {PageSnapshot} */ before, /** @type {PageSnapshot} */ after) {
    /** @type {string[]} */
    const reasons = []
    if (before.url !== after.url) reasons.push(`address moved to ${after.url}`)
    if (before.title !== after.title) reasons.push(`title became "${after.title}"`)
    if (after.visibleFields > before.visibleFields) {
      reasons.push(`${after.visibleFields - before.visibleFields} field(s) became visible`)
    }
    if (after.visibleFields < before.visibleFields) {
      reasons.push(`${before.visibleFields - after.visibleFields} field(s) disappeared`)
    }
    const beforeMap = new Map(before.fields.map((/** @type {{ k: string, v: string }} */ f) => [f.k, f.v]))
    for (const field of after.fields) {
      const prior = beforeMap.get(field.k)
      if (prior === undefined) reasons.push(`field ${field.k} appeared`)
      else if (prior !== field.v) reasons.push(`field ${field.k} changed`)
    }
    if (after.marked !== before.marked) reasons.push('expansion state changed')
    if (after.textLen !== before.textLen) {
      reasons.push(`page text length changed by ${after.textLen - before.textLen}`)
    }
    return reasons
  }

  /**
   * A targeted query over the interactive set: page_read stays the survey,
   * page_find is the question. Matches come back registered as refs when a
   * registry is attached, added alongside the last read's rather than
   * replacing it.
   */
  async function pageFind(/** @type {any} */ args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { error: 'nothing to find; give page_find a word or phrase' }
    const found = await evalJson(`(${FIND_EXPRESSION})(${JSON.stringify({ q: query })})`)
    const items = Array.isArray(found?.items) ? found.items : []
    if (items.length === 0) {
      return { ok: true, matches: 0, scanned: Number(found?.scanned ?? 0), items: [] }
    }
    const listed = options.elements && host.context ? options.elements.add(items, host.context()) : items
    return { ok: true, matches: items.length, scanned: Number(found?.scanned ?? 0), items: listed }
  }

  /**
   * What the memory graph already knows. Free to call and cheap to answer;
   * each element comes back with the selector an action can use directly.
   */
  async function pageRecall(/** @type {any} */ args) {
    const query = String(args.query ?? '').trim()
    if (!query) return { error: 'nothing to recall; give page_recall a word or phrase' }
    if (!options.memory?.recall) {
      return { error: 'page memory is not enabled; turn it on in settings and it will build as pages are read' }
    }
    const result = options.memory.recall(query, { origin: args.origin, limit: args.limit })
    if (result?.enabled === false) {
      return { error: 'page memory is off; turn it on in settings and it will build as pages are read' }
    }
    return capResult(result)
  }

  /**
   * Several actions in one call. Each op passes through the same guards the
   * standalone tools apply; the first refusal stops the sequence, because
   * continuing a recipe past a refusal is worse than stopping early.
   */
  async function pageAct(/** @type {any} */ args) {
    const ops = Array.isArray(args.ops) ? args.ops : []
    if (ops.length === 0) return { error: 'nothing to do; ops is an empty list' }
    if (ops.length > MAX_ACT_OPS) return { error: `a batch is limited to ${MAX_ACT_OPS} operations` }
    const dispatch = /** @type {Record<string, (a: any) => Promise<any>>} */ ({
      click: pageClick,
      fill: pageFill,
      select: pageSelect,
      text: pageText,
      read: () => pageRead({}),
    })
    const results = []
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] ?? {}
      const run = dispatch[String(op.op ?? '')]
      if (!run) return { ok: false, stoppedAt: i, error: `op ${i}: unknown op "${String(op.op ?? '')}"`, results }
      const result = await run(op)
      results.push(result)
      if (result?.error || result?.ok === false) {
        return { ok: false, stoppedAt: i, results }
      }
    }
    return { ok: true, results }
  }

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const tools = {
    page_read: pageRead,
    page_find: pageFind,
    page_recall: pageRecall,
    page_act: pageAct,
    page_text: pageText,
    page_navigate: pageNavigate,
    page_click: pageClick,
    page_fill: pageFill,
    page_select: pageSelect,
  }
  if (host.readVisual) tools.page_read_visual = pageReadVisual
  if (options.includeScrape !== false) tools.page_scrape = pageScrape

  const elementKey = options.elements ? 'ref' : 'selector'
  const elementProperty = options.elements
    ? { ref: { type: 'string', description: 'opaque element reference returned by the latest page_read' } }
    : { selector: { type: 'string' } }

  /** @type {ToolSpec[]} */
  const specs = [
    {
      name: 'page_read',
      description: options.elements
        ? 'Read facts about the active tab and its interactive elements. Read before acting; use only the opaque element refs returned by the latest read. Pass since to get back only what changed.'
        : 'Read facts about the active tab: title, counts, a text preview, and every interactive element with a unique selector. Read this before acting; only use selectors it gave you.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          since: {
            type: 'boolean',
            description: 'when true and this session already read this url, return only added/changed/removed elements instead of the full inventory',
          },
        },
      },
    },
    {
      name: 'page_find',
      description: 'Find interactive elements matching a word or phrase without re-reading the whole page. Returns a few matches, each usable as an element ref.',
      gated: false,
      input: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'page_recall',
      description: 'Recall what this browser already learned about pages and controls, without reading the page again. Returns matching elements with usable selectors, matching pages, and recorded paths.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          origin: { type: 'string', description: 'limit recall to one origin' },
          limit: { type: 'integer' },
        },
        required: ['query'],
      },
    },
    {
      name: 'page_act',
      description: 'Run several actions in order (click/fill/select/text/read) as one call. The first error or refusal stops the sequence.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            items: { type: 'object' },
            description: 'ordered operations: {op, ref|selector, text|value}',
          },
        },
        required: ['ops'],
      },
    },
    ...(host.readVisual
      ? [{
          name: 'page_read_visual',
          description: 'Read the page through Troy\'s fused DOM and OCR pipeline when canvas, images or visual regions matter.',
          gated: false,
          input: { type: 'object', properties: {} },
        }]
      : []),
    ...(options.includeScrape !== false
      ? [{
          name: 'page_scrape',
          description: 'Fetch one https address over plain HTTP through curl_reap, without rendering it. For reading pages fast or past clients that block automation.',
          gated: false,
          input: { type: 'object', properties: { url: { type: 'string', description: 'https address to fetch' } }, required: ['url'] },
        }]
      : []),
    {
      name: 'page_text',
      description: options.elements
        ? 'Read the exact visible text of one element using a ref from the latest page_read.'
        : 'Read the exact visible text of one element by selector. Use when page_read\'s preview is not enough and you need a specific section, table or paragraph.',
      gated: false,
      input: { type: 'object', properties: elementProperty, required: [elementKey] },
    },
    {
      name: 'page_navigate',
      description: 'Navigate the tab to an address or search phrase through the same rules as the address bar and this session\'s exact-origin scope.',
      gated: true,
      input: { type: 'object', properties: { url: { type: 'string', description: 'address or search phrase' } }, required: ['url'] },
    },
    {
      name: 'page_click',
      description: options.elements
        ? 'Click one element ref from the latest page_read. Irreversible controls are blocked; refs stay usable until the page navigates.'
        : 'Click one element by selector. Submit-shaped controls are refused; the click must observably change the page or it reports NOT VERIFIED.',
      gated: true,
      input: { type: 'object', properties: options.elements ? elementProperty : { ...elementProperty, within: { type: 'string', description: 'optional container to scope the selector' } }, required: [elementKey] },
    },
    {
      name: 'page_fill',
      description: options.elements
        ? 'Fill one ordinary text field ref from the latest page_read, then verify it. Sensitive fields are blocked; refs stay usable until the page navigates.'
        : 'Type text into one input by selector, then read it back to verify. Password fields and over-maxlength answers are refused.',
      gated: true,
      input: { type: 'object', properties: { ...elementProperty, text: { type: 'string' } }, required: [elementKey, 'text'] },
    },
    {
      name: 'page_select',
      description: options.elements
        ? 'Choose an option in one select ref from the latest page_read, then verify it. Refs stay usable until the page navigates.'
        : 'Choose one option of a <select> dropdown, matched by the option\'s label or value, then read the selection back to verify. The full option list is reported when nothing matches.',
      gated: true,
      input: { type: 'object', properties: { ...elementProperty, value: { type: 'string', description: 'option label or value to select' } }, required: [elementKey, 'value'] },
    },
  ]

  return {
    specs,
    async run(name, args) {
      const tool = tools[name]
      if (!tool) return { error: `unknown tool ${name}` }
      try {
        assertNotAborted()
        const result = await tool(args ?? {})
        assertNotAborted()
        return capResult(result)
      } catch (err) {
        const error = /** @type {Error} */ (err)
        if (error?.name === 'AbortError' || options.signal?.aborted) {
          return { error: 'the agent run was cancelled', cancelled: true }
        }
        return { error: String(error?.message ?? err) }
      }
    },
  }
}
