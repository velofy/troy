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
// text, scrape).
// The gate is not enforced here: run() executes what it is told. Consent is
// the caller's job (the panel asks; tests pass a scripted gate), because a
// gate inside the tool layer would be untestable without Electron.

/** Result payloads larger than this are cut and flagged. */
export const MAX_TOOL_RESULT_CHARS = 20000

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
  return {
    ...result,
    truncated: true,
    note: `result was longer than ${MAX_TOOL_RESULT_CHARS} characters and was truncated`,
  }
}

/** Expressions the click and fill tools evaluate against the live page. */

const INSPECT_EXPRESSION = `(expr) => (() => {
  const scope = expr.within ? document.querySelector(expr.within) : document
  if (expr.within && !scope) return JSON.stringify({ scopeMissing: expr.within })
  let matches
  try { matches = scope.querySelectorAll(expr.selector) } catch { return JSON.stringify({ count: 0, items: [], badSelector: true }) }
  const items = []
  for (const el of Array.from(matches).slice(0, 5)) {
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? (el.getAttribute('type') || 'text') : ''
    items.push({
      tag,
      type,
      name: el.getAttribute('name') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 120),
      value: type === 'password' ? '' : String(el.value ?? ''),
      disabled: Boolean(el.disabled),
      // Same rule as page_read: only a form behind the button makes it a
      // submitter. An orphan typeless button cannot commit anything.
      defaultSubmit: ((tag === 'button' && !type) || type === 'submit') &&
        Boolean(el.closest('form')),
      editable: tag === 'textarea' || el.isContentEditable === true ||
        (tag === 'input' && !['button', 'submit', 'checkbox', 'radio', 'file', 'hidden', 'password', 'range'].includes(type)),
      maxLength: el.maxLength >= 0 ? el.maxLength : null,
      readOnly: Boolean(el.readOnly),
    })
  }
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

// Reading one element's own words. The count is checked here, in the page,
// because picking the first of many matches silently is exactly the guess
// this layer refuses to make.
const TEXT_EXPRESSION = `(sel) => (() => {
  let matches
  try { matches = document.querySelectorAll(sel) } catch { return JSON.stringify({ badSelector: true }) }
  if (matches.length !== 1) return JSON.stringify({ count: matches.length, text: '' })
  const el = matches[0]
  const r = el.getBoundingClientRect()
  return JSON.stringify({
    count: 1,
    text: (el.innerText || '').trim(),
    visible: r.width > 0 && r.height > 0,
  })
})()`

/**
 * @typedef {object} ToolHost
 * @property {() => Promise<unknown>} read full page facts for the active tab
 * @property {(expression: string) => Promise<unknown>} evaluate run JS in the page
 * @property {(input: string) => { kind: string, url?: string, reason?: string }} resolve omnibox resolver
 * @property {(url: string) => Promise<unknown>} load navigate the tab
 * @property {(cmd: string, args: string[]) => Promise<{ code?: number, stdout?: string, stderr?: string } | { missing: string }>} exec run a subprocess
 * @property {() => Promise<void>} settle wait for the page to stop moving
 */

/**
 * @param {ToolHost} host
 * @returns {{ specs: ToolSpec[], run: (name: string, args?: any) => Promise<Record<string, unknown>> }}
 */
export function createTools(host) {
  /**
   * Evaluate and parse a JSON-returning expression. Over CDP the page hands
   * back a JSON string; scripted hosts in tests hand objects straight
   * through, so both spellings are accepted at this one seam.
   */
  async function evalJson(/** @type {string} */ expression) {
    const raw = await host.evaluate(expression)
    if (typeof raw === 'string') return JSON.parse(raw)
    return raw
  }

  async function pageRead() {
    return capResult(await host.read())
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
        await host.load(resolved.url ?? '')
        await host.settle()
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
    const inspection = await evalJson(
      `(${INSPECT_EXPRESSION})(${JSON.stringify({ selector: args.selector, within: args.within })})`,
    )
    if (inspection.scopeMissing) {
      return { error: `the scope container ${inspection.scopeMissing} matched nothing; refusing to act outside it` }
    }
    if (inspection.badSelector) {
      return { error: `nothing matched ${args.selector} (the selector itself failed to compile)` }
    }
    if (inspection.count === 0) {
      return { error: `nothing matched ${args.selector}; refusing to guess` }
    }
    if (inspection.count > 1) {
      const summaries = inspection.items
        .map((/** @type {InspectItem} */ item) => `<${item.tag}> ${item.text || item.name || item.type}`.trim())
        .join('; ')
      return { error: `${inspection.count} elements matched ${args.selector}: ${summaries}. Refusing to choose among them; narrow the selector or add a within container.` }
    }
    return { item: inspection.items[0] }
  }

  async function pageClick(/** @type {any} */ args) {
    const found = await inspectOne(args)
    if (found.error) return found
    const item = /** @type {InspectItem} */ (found.item)
    if (item.disabled) return { error: `that control is disabled` }
    if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
    if (SUBMIT_PATTERN.test(item.text)) {
      return { error: `"${item.text}" reads like a submit or commit action, which is always yours to click` }
    }
    if (item.defaultSubmit) {
      return { error: `that button would submit its form, which is always yours to click` }
    }

    const before = await evalJson(SNAPSHOT_EXPRESSION)
    await host.evaluate(`(${CLICK_EXPRESSION})(${JSON.stringify(args.selector)})`)
    await host.settle()
    const after = await evalJson(SNAPSHOT_EXPRESSION)

    const reasons = diffSnapshots(before, after)
    if (reasons.length === 0) {
      return {
        ok: false,
        changed: false,
        note: 'NOT VERIFIED: the click ran but nothing observably changed on the page',
        reasons,
      }
    }
    return { ok: true, changed: true, reasons }
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
    if (found.error) return found
    const item = /** @type {InspectItem} */ (found.item)
    if (item.type === 'password') return { error: 'password fields are never filled by the agent' }
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

    await host.evaluate(`(${FILL_EXPRESSION})(${JSON.stringify({ selector: args.selector, text })})`)
    await host.settle()
    const rawBack = await host.evaluate(`(${READBACK_EXPRESSION})(${JSON.stringify(args.selector)})`)
    const landed = typeof rawBack === 'string' ? rawBack : String(rawBack ?? '')
    if (landed !== text) {
      return {
        ok: false,
        note: `MISMATCH: wrote ${text.length} characters, read back "${landed.slice(0, 120)}"; the page rewrote or dropped the value`,
      }
    }
    return { ok: true, changed: true }
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
    if (found.error) return found
    const item = /** @type {InspectItem} */ (found.item)
    if (item.disabled) return { error: 'that control is disabled' }
    if (item.tag !== 'select') {
      return { error: `<${item.tag}> is not a dropdown; page_select only operates <select> elements` }
    }

    const act = await evalJson(`(${SELECT_EXPRESSION})(${JSON.stringify({ selector: args.selector, value })})`)
    if (!act.acted) {
      const listed = (act.options ?? []).map((/** @type {{ label?: string }} */ o) => o.label || o.value).join(', ')
      return { error: `no option matched "${value}". The options are: ${listed}` }
    }
    await host.settle()
    const rawBack = await host.evaluate(`(${SELECT_READBACK_EXPRESSION})(${JSON.stringify(args.selector)})`)
    const landed = typeof rawBack === 'string' ? rawBack : String(rawBack ?? '')
    if (landed !== act.label) {
      return {
        ok: false,
        note: `MISMATCH: asked for "${act.label}" but the selection now reads "${landed.slice(0, 120)}"; the page rewrote it`,
      }
    }
    return { ok: true, changed: true, selected: act.label, value: act.value }
  }

  async function pageText(/** @type {any} */ args) {
    if (!String(args.selector ?? '').trim()) {
      return { error: 'no selector given' }
    }
    const read = await evalJson(`(${TEXT_EXPRESSION})(${JSON.stringify(String(args.selector))})`)
    if (read.badSelector) {
      return { error: `${args.selector} is not a usable selector` }
    }
    if (read.count === 0) {
      return { error: `nothing matched ${args.selector}; refusing to guess` }
    }
    if (read.count > 1) {
      return { error: `${read.count} elements matched ${args.selector}. Refusing to choose among them; narrow the selector or add a within container.` }
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

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const tools = {
    page_read: pageRead,
    page_text: pageText,
    page_navigate: pageNavigate,
    page_click: pageClick,
    page_fill: pageFill,
    page_select: pageSelect,
    page_scrape: pageScrape,
  }

  /** @type {ToolSpec[]} */
  const specs = [
    {
      name: 'page_read',
      description: 'Read facts about the active tab: title, counts, a text preview, and every interactive element with a unique selector. Read this before acting; only use selectors it gave you.',
      gated: false,
      input: { type: 'object', properties: {} },
    },
    {
      name: 'page_scrape',
      description: 'Fetch one https address over plain HTTP through curl_reap, without rendering it. For reading pages fast or past clients that block automation.',
      gated: false,
      input: { type: 'object', properties: { url: { type: 'string', description: 'https address to fetch' } }, required: ['url'] },
    },
    {
      name: 'page_text',
      description: 'Read the exact visible text of one element by selector. Use when page_read\'s preview is not enough and you need a specific section, table or paragraph.',
      gated: false,
      input: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    },
    {
      name: 'page_navigate',
      description: 'Navigate the tab to an address or search phrase, through the same rules as the address bar. Refused schemes stay refused.',
      gated: true,
      input: { type: 'object', properties: { url: { type: 'string', description: 'address or search phrase' } }, required: ['url'] },
    },
    {
      name: 'page_click',
      description: 'Click one element by selector. Submit-shaped controls are refused; the click must observably change the page or it reports NOT VERIFIED.',
      gated: true,
      input: { type: 'object', properties: { selector: { type: 'string' }, within: { type: 'string', description: 'optional container to scope the selector' } }, required: ['selector'] },
    },
    {
      name: 'page_fill',
      description: 'Type text into one input by selector, then read it back to verify. Password fields and over-maxlength answers are refused.',
      gated: true,
      input: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
    },
    {
      name: 'page_select',
      description: 'Choose one option of a <select> dropdown, matched by the option\'s label or value, then read the selection back to verify. The full option list is reported when nothing matches.',
      gated: true,
      input: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string', description: 'option label or value to select' } }, required: ['selector', 'value'] },
    },
  ]

  return {
    specs,
    async run(name, args) {
      const tool = tools[name]
      if (!tool) return { error: `unknown tool ${name}` }
      try {
        return capResult(await tool(args ?? {}))
      } catch (err) {
        return { error: String(/** @type {Error} */ (err)?.message ?? err) }
      }
    },
  }
}
