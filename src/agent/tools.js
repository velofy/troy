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
//   (Screenshots are exempt from the 20KB cap so base64 PNG data arrives intact.)
//
// Tools are marked gated (navigate, click, fill, select, press, scroll, hover,
// history, eval, act) or free (read, find, recall, text, wait, screenshot,
// console, network, scrape).

import path from 'node:path'
import {
  COLLECT_INTERACTIVE_EXPRESSION,
  DEEP_QUERY_ALL_EXPRESSION,
  DEEP_QUERY_ONE_EXPRESSION,
  ELEMENT_DESCRIPTOR_EXPRESSION,
  GET_VIEWPORT_RECT_EXPRESSION,
  SELECTOR_FOR_EXPRESSION,
} from './element-descriptor.js'
import { validateUploadFiles } from './policy.js'

export { validateUploadFiles }

/** Result payloads larger than this are cut and flagged. */
export const MAX_TOOL_RESULT_CHARS = 20000
export const MAX_INTERACTIVE_ELEMENTS = 300
export const MAX_FIND_RESULTS = 15
export const MAX_ACT_OPS = 20
export const MAX_WAIT_MS = 30000

/** Text that reads like committing something. Clicking one of these is how
 * an order gets placed, so the answer is no before any heuristic runs
 * unless explicitly permitted with allowSubmit: true. */
const SUBMIT_PATTERN = /submit|commit|place (the )?order|checkout|pay\b|purchase|send\b|confirm/i

/**
 * One interactive element as the inspection expression reported it.
 *
 * @typedef {object} InspectItem
 * @property {string} tag
 * @property {string} type
 * @property {string} [id]
 * @property {string} name
 * @property {string} [role]
 * @property {string} text
 * @property {string} [label]
 * @property {string} [ariaLabel]
 * @property {string} value
 * @property {boolean} [valueRedacted]
 * @property {boolean} disabled
 * @property {boolean} defaultSubmit
 * @property {boolean} editable
 * @property {number | null} maxLength
 * @property {boolean} readOnly
 * @property {boolean} [multiple]
 * @property {string} [href]
 * @property {boolean} [download]
 * @property {string} [formAction]
 * @property {string} [signature]
 */

/**
 * @typedef {{
 *   url: string,
 *   title: string,
 *   visibleFields: number,
 *   fieldCount: number,
 *   fields: Array<{ k: string, v: string }>,
 *   marked: number,
 *   textLen: number,
 *   textHash?: number,
 *   elementCount?: number,
 *   active?: string,
 *   states?: string[],
 * }} PageSnapshot
 */

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

/**
 * Sleep for `ms` milliseconds, rejecting immediately with AbortError if the
 * signal aborts before the timer elapses.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error('the agent run was cancelled')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      const error = signal?.reason instanceof Error ? signal.reason : new Error('the agent run was cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(undefined)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Expressions the tools evaluate against the live page. */

const INSPECT_EXPRESSION = `(expr) => (() => {
  const deepQueryAll = ${DEEP_QUERY_ALL_EXPRESSION}
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  let scope = document
  if (expr.within) {
    try { scope = deepQueryOne(document, expr.within) } catch { return JSON.stringify({ scopeMissing: expr.within }) }
    if (!scope) return JSON.stringify({ scopeMissing: expr.within })
  }
  let matches
  try { matches = deepQueryAll(scope, expr.selector) } catch { return JSON.stringify({ count: 0, items: [], badSelector: true }) }
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const items = matches.slice(0, 5).map(describe)
  return JSON.stringify({ count: matches.length, items })
})()`

// Deterministic fallback recovery when a ref's selector has 0 matches on the
// same (tabId, url, epoch): search light + open shadow DOM in strict priority
// order (id, ariaLabel, name+tag, role+ariaLabel) and accept ONLY a unique hit.
const RECOVER_ELEMENT_EXPRESSION = `(anchor) => (() => {
  const collectInteractive = ${COLLECT_INTERACTIVE_EXPRESSION}
  const selectorFor = ${SELECTOR_FOR_EXPRESSION}
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const body = document.body || document.documentElement
  if (!body) return JSON.stringify({ found: false })
  const candidates = collectInteractive(body).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  })
  const described = candidates.map((el) => ({ el, d: describe(el) }))
  const tag = String(anchor.tag || '')
  const tiers = []
  if (anchor.id) {
    tiers.push((x) => x.d.id === anchor.id && (!tag || x.d.tag === tag))
  }
  if (anchor.ariaLabel) {
    tiers.push((x) => x.d.ariaLabel === anchor.ariaLabel && (!tag || x.d.tag === tag))
  }
  if (anchor.name && tag) {
    tiers.push((x) => x.d.name === anchor.name && x.d.tag === tag)
  }
  if (anchor.role && anchor.ariaLabel) {
    tiers.push((x) => x.d.role === anchor.role && x.d.ariaLabel === anchor.ariaLabel)
  }
  for (const pred of tiers) {
    const hits = described.filter(pred)
    if (hits.length === 1) {
      return JSON.stringify({
        found: true,
        selector: selectorFor(hits[0].el),
        item: hits[0].d,
      })
    }
  }
  return JSON.stringify({ found: false })
})()`

// Batched live check for page_recall: verify which recalled selectors uniquely
// match an element on the current page so refs can be issued immediately.
const RECALL_BIND_EXPRESSION = `(selectors) => (() => {
  const deepQueryAll = ${DEEP_QUERY_ALL_EXPRESSION}
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const bound = {}
  for (const sel of selectors) {
    if (!sel || typeof sel !== 'string') continue
    try {
      const matches = deepQueryAll(document, sel)
      if (matches.length === 1) {
        bound[sel] = { selector: sel, ...describe(matches[0]) }
      }
    } catch {
      // Ignore selectors invalid on this document.
    }
  }
  return JSON.stringify(bound)
})()`

const SNAPSHOT_EXPRESSION = `(() => {
  const body = document.body
  const allRoots = [document]
  const visited = new Set([document])
  for (let i = 0; i < allRoots.length; i++) {
    const root = allRoots[i]
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot && !visited.has(el.shadowRoot)) {
        visited.add(el.shadowRoot)
        allRoots.push(el.shadowRoot)
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let frameDoc = null
        try { frameDoc = el.contentDocument || null } catch { frameDoc = null }
        if (frameDoc && !visited.has(frameDoc)) {
          visited.add(frameDoc)
          allRoots.push(frameDoc)
        }
      }
    }
  }
  const queryDeep = (sel) => {
    const out = []
    for (const r of allRoots) {
      for (const el of r.querySelectorAll(sel)) out.push(el)
    }
    return out
  }
  const allFields = queryDeep('input:not([type=hidden]), textarea')
  const fields = allFields
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 })
    .slice(0, 50)
    .map((el) => ({ k: el.name || el.id || '', v: el.type === 'password' ? '' : String(el.value ?? '') }))
  const marked = queryDeep('[data-troy-marked], .open, [aria-expanded="true"]').length
  const states = []
  for (const el of queryDeep('input[type="checkbox"], input[type="radio"], [aria-checked], [aria-selected], [aria-pressed], [aria-expanded], details, dialog')) {
    if (states.length >= 100) break
    const tag = el.tagName.toLowerCase()
    const key = tag + (el.id ? '#' + el.id : el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '')
    const parts = []
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) parts.push('checked=' + Boolean(el.checked))
    if (tag === 'details' || tag === 'dialog') parts.push('open=' + Boolean(el.open))
    for (const attr of ['aria-checked', 'aria-selected', 'aria-pressed', 'aria-expanded']) {
      if (el.hasAttribute(attr)) parts.push(attr + '=' + el.getAttribute(attr))
    }
    if (parts.length) states.push(key + ':' + parts.join(','))
  }
  let activeEl = document.activeElement
  for (let depth = 0; depth < 16 && activeEl; depth++) {
    if (activeEl.shadowRoot && activeEl.shadowRoot.activeElement) {
      activeEl = activeEl.shadowRoot.activeElement
      continue
    }
    if (activeEl.tagName === 'IFRAME' || activeEl.tagName === 'FRAME') {
      let innerActive = null
      try { innerActive = activeEl.contentDocument ? activeEl.contentDocument.activeElement : null } catch { innerActive = null }
      if (innerActive && innerActive !== activeEl) {
        activeEl = innerActive
        continue
      }
    }
    break
  }
  const active = activeEl
    ? activeEl.tagName.toLowerCase() + (activeEl.id ? '#' + activeEl.id : '') + (activeEl.getAttribute('name') ? '[name=' + activeEl.getAttribute('name') + ']' : '')
    : ''
  let text = body ? (body.innerText || '') : ''
  for (let i = 1; i < allRoots.length; i++) {
    const r = allRoots[i]
    text += '\\n' + (r.body ? (r.body.innerText || r.body.textContent || '') : (r.textContent || ''))
  }
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  let elementCount = 0
  for (const r of allRoots) elementCount += r.querySelectorAll('*').length
  return JSON.stringify({
    url: location.href,
    title: document.title,
    visibleFields: fields.length,
    fieldCount: allFields.length,
    fields,
    marked,
    textLen: text.length,
    textHash: hash >>> 0,
    elementCount,
    active,
    states,
  })
})()`

const SCROLL_INTO_VIEW_HELPER = `(function scrollIntoViewDeep(el) {
  let win = el.ownerDocument && el.ownerDocument.defaultView
  const frames = []
  while (win && win !== window) {
    let frameEl = null
    try { frameEl = win.frameElement } catch { break }
    if (!frameEl) break
    frames.push(frameEl)
    win = frameEl.ownerDocument && frameEl.ownerDocument.defaultView
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    try { frames[i].scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch {}
  }
  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
})`

const CLICK_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const scrollIntoViewDeep = ${SCROLL_INTO_VIEW_HELPER}
  const selector = typeof cmd === 'string' ? cmd : String(cmd.selector || '')
  const button = typeof cmd === 'object' && cmd && cmd.button ? cmd.button : 'left'
  const clickCount = typeof cmd === 'object' && cmd && cmd.clickCount ? Number(cmd.clickCount) : 1
  const el = deepQueryOne(document, selector)
  if (!el) return JSON.stringify({ acted: false, reason: 'gone' })
  scrollIntoViewDeep(el)
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
  const ME = view.MouseEvent || MouseEvent
  const PE = view.PointerEvent || PointerEvent
  if (button === 'right') {
    const init = { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: cx, clientY: cy }
    el.dispatchEvent(new PE('pointerdown', init))
    el.dispatchEvent(new ME('mousedown', init))
    el.dispatchEvent(new PE('pointerup', { ...init, buttons: 0 }))
    el.dispatchEvent(new ME('mouseup', { ...init, buttons: 0 }))
    el.dispatchEvent(new ME('contextmenu', { ...init, buttons: 0 }))
    return JSON.stringify({ acted: true })
  }
  if (button === 'middle') {
    const init = { bubbles: true, cancelable: true, composed: true, button: 1, buttons: 4, clientX: cx, clientY: cy }
    el.dispatchEvent(new PE('pointerdown', init))
    el.dispatchEvent(new ME('mousedown', init))
    el.dispatchEvent(new PE('pointerup', { ...init, buttons: 0 }))
    el.dispatchEvent(new ME('mouseup', { ...init, buttons: 0 }))
    el.dispatchEvent(new ME('auxclick', { ...init, buttons: 0 }))
    return JSON.stringify({ acted: true })
  }
  if (clickCount >= 2) {
    for (let i = 0; i < clickCount; i++) el.click()
    el.dispatchEvent(new ME('dblclick', { bubbles: true, cancelable: true, composed: true, button: 0, detail: 2, clientX: cx, clientY: cy }))
    return JSON.stringify({ acted: true })
  }
  el.click()
  return JSON.stringify({ acted: true })
})()`

// Scroll target into view and compute frame-accurate top-level viewport center
// for trusted CDP clickPoint; falls back to el.click() if hidden/offscreen.
const CLICK_PREPARE_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const getViewportRect = ${GET_VIEWPORT_RECT_EXPRESSION}
  const scrollIntoViewDeep = ${SCROLL_INTO_VIEW_HELPER}
  const el = deepQueryOne(document, cmd.selector)
  if (!el) return JSON.stringify({ found: false, acted: false })
  scrollIntoViewDeep(el)
  const vr = getViewportRect(el)
  const cx = vr.left + vr.width / 2
  const cy = vr.top + vr.height / 2
  const inViewport =
    vr.width > 0 &&
    vr.height > 0 &&
    cx >= 0 &&
    cy >= 0 &&
    cx <= (window.innerWidth || 0) &&
    cy <= (window.innerHeight || 0)
  if (!inViewport) {
    if (cmd.button === 'left' && cmd.clickCount === 1) {
      el.click()
      return JSON.stringify({ found: true, visible: false, acted: true })
    }
    return JSON.stringify({ found: true, visible: false, acted: false, x: cx, y: cy })
  }
  return JSON.stringify({ found: true, visible: true, acted: false, x: cx, y: cy })
})()`

// JS fallback for coordinate click when host.clickPoint is absent.
const CLICK_COORD_JS_EXPRESSION = `(cmd) => (() => {
  let doc = document
  let lx = Number(cmd.x)
  let ly = Number(cmd.y)
  let target = null
  for (let depth = 0; depth < 16; depth++) {
    const hit = doc && typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(lx, ly) : null
    if (!hit) break
    target = hit
    if (hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
      const inner = hit.shadowRoot.elementFromPoint(lx, ly)
      if (inner && inner !== hit) {
        target = inner
        doc = hit.shadowRoot
        continue
      }
    }
    if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') {
      let frameDoc = null
      try { frameDoc = hit.contentDocument || null } catch { frameDoc = null }
      if (frameDoc) {
        const fr = hit.getBoundingClientRect()
        const parentWin = hit.ownerDocument && hit.ownerDocument.defaultView
        const style = parentWin && typeof parentWin.getComputedStyle === 'function' ? parentWin.getComputedStyle(hit) : null
        const bL = style ? (parseFloat(style.borderLeftWidth) || 0) : 0
        const bT = style ? (parseFloat(style.borderTopWidth) || 0) : 0
        const pL = style ? (parseFloat(style.paddingLeft) || 0) : 0
        const pT = style ? (parseFloat(style.paddingTop) || 0) : 0
        lx = lx - fr.left - bL - pL
        ly = ly - fr.top - bT - pT
        doc = frameDoc
        continue
      }
    }
    break
  }
  if (!target) return JSON.stringify({ acted: false })
  const view = (target.ownerDocument && target.ownerDocument.defaultView) || window
  const ME = view.MouseEvent || MouseEvent
  const PE = view.PointerEvent || PointerEvent
  const button = cmd.button || 'left'
  const clickCount = Number(cmd.clickCount || 1)
  const btnCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
  const btnMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1
  const init = { bubbles: true, cancelable: true, composed: true, button: btnCode, buttons: btnMask, clientX: lx, clientY: ly }
  for (let c = 1; c <= clickCount; c++) {
    target.dispatchEvent(new PE('pointerdown', { ...init, detail: c }))
    target.dispatchEvent(new ME('mousedown', { ...init, detail: c }))
    target.dispatchEvent(new PE('pointerup', { ...init, buttons: 0, detail: c }))
    target.dispatchEvent(new ME('mouseup', { ...init, buttons: 0, detail: c }))
    if (button === 'left') {
      target.dispatchEvent(new ME('click', { ...init, buttons: 0, detail: c }))
    }
  }
  if (button === 'left' && clickCount >= 2) {
    target.dispatchEvent(new ME('dblclick', { ...init, buttons: 0, detail: 2 }))
  } else if (button === 'right') {
    target.dispatchEvent(new ME('contextmenu', { ...init, buttons: 0 }))
  } else if (button === 'middle') {
    target.dispatchEvent(new ME('auxclick', { ...init, buttons: 0 }))
  }
  return JSON.stringify({ acted: true, tag: target.tagName.toLowerCase() })
})()`

// Compute frame-accurate top-level viewport center of one element.
const ELEMENT_CENTER_EXPRESSION = `(sel) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const getViewportRect = ${GET_VIEWPORT_RECT_EXPRESSION}
  const scrollIntoViewDeep = ${SCROLL_INTO_VIEW_HELPER}
  const el = deepQueryOne(document, sel)
  if (!el) return JSON.stringify({ found: false })
  scrollIntoViewDeep(el)
  const vr = getViewportRect(el)
  const visible = vr.width > 0 || vr.height > 0
  return JSON.stringify({
    found: true,
    visible,
    x: vr.left + vr.width / 2,
    y: vr.top + vr.height / 2,
  })
})()`

// JS pointer + HTML5 drag-and-drop fallback when host.dragPoints is absent.
const DRAG_JS_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const fromEl = cmd.fromSelector
    ? deepQueryOne(document, cmd.fromSelector)
    : document.elementFromPoint(cmd.fromX, cmd.fromY)
  const toEl = cmd.toSelector
    ? deepQueryOne(document, cmd.toSelector)
    : document.elementFromPoint(cmd.toX, cmd.toY)
  const startTarget = fromEl || document.body || document.documentElement
  const endTarget = toEl || startTarget
  if (!startTarget) return JSON.stringify({ acted: false })
  const view = (startTarget.ownerDocument && startTarget.ownerDocument.defaultView) || window
  const ME = view.MouseEvent || MouseEvent
  const PE = view.PointerEvent || PointerEvent
  const DE = view.DragEvent || DragEvent
  const steps = Math.max(1, Number(cmd.steps || 10))
  startTarget.dispatchEvent(new PE('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: cmd.fromX, clientY: cmd.fromY }))
  startTarget.dispatchEvent(new ME('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: cmd.fromX, clientY: cmd.fromY }))
  let dt = null
  try { dt = new (view.DataTransfer || DataTransfer)() } catch { dt = null }
  try {
    startTarget.dispatchEvent(new DE('dragstart', { bubbles: true, cancelable: true, composed: true, clientX: cmd.fromX, clientY: cmd.fromY, ...(dt ? { dataTransfer: dt } : {}) }))
  } catch {}
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mx = cmd.fromX + (cmd.toX - cmd.fromX) * t
    const my = cmd.fromY + (cmd.toY - cmd.fromY) * t
    const moveTarget = i === steps ? endTarget : startTarget
    moveTarget.dispatchEvent(new PE('pointermove', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: mx, clientY: my }))
    moveTarget.dispatchEvent(new ME('mousemove', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: mx, clientY: my }))
  }
  try {
    endTarget.dispatchEvent(new DE('dragenter', { bubbles: true, cancelable: true, composed: true, clientX: cmd.toX, clientY: cmd.toY, ...(dt ? { dataTransfer: dt } : {}) }))
    endTarget.dispatchEvent(new DE('dragover', { bubbles: true, cancelable: true, composed: true, clientX: cmd.toX, clientY: cmd.toY, ...(dt ? { dataTransfer: dt } : {}) }))
    endTarget.dispatchEvent(new DE('drop', { bubbles: true, cancelable: true, composed: true, clientX: cmd.toX, clientY: cmd.toY, ...(dt ? { dataTransfer: dt } : {}) }))
    startTarget.dispatchEvent(new DE('dragend', { bubbles: true, cancelable: true, composed: true, clientX: cmd.toX, clientY: cmd.toY, ...(dt ? { dataTransfer: dt } : {}) }))
  } catch {}
  endTarget.dispatchEvent(new PE('pointerup', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, clientX: cmd.toX, clientY: cmd.toY }))
  endTarget.dispatchEvent(new ME('mouseup', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0, clientX: cmd.toX, clientY: cmd.toY }))
  return JSON.stringify({ acted: true })
})()`

// SPA-grade fill: uses native prototype value setter from the element's own
// realm so React/Vue/Svelte/Angular controlled inputs (including inside
// same-origin iframes) observe the change, then fires composed InputEvent + change.
const FILL_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const el = deepQueryOne(document, cmd.selector)
  if (!el) return JSON.stringify({ acted: false, reason: 'gone' })
  el.scrollIntoView({ block: 'center' })
  el.focus()
  const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
  const IE = view.InputEvent || InputEvent
  const EV = view.Event || Event
  const fireInput = () => {
    try {
      el.dispatchEvent(new IE('input', {
        bubbles: true,
        composed: true,
        data: cmd.text,
        inputType: cmd.text === '' ? 'deleteContentBackward' : 'insertText',
      }))
    } catch {
      el.dispatchEvent(new EV('input', { bubbles: true, composed: true }))
    }
    el.dispatchEvent(new EV('change', { bubbles: true, composed: true }))
  }
  if (el.isContentEditable) {
    el.textContent = cmd.text
    fireInput()
  } else {
    const proto = el.tagName === 'TEXTAREA'
      ? (view.HTMLTextAreaElement || HTMLTextAreaElement).prototype
      : el.tagName === 'INPUT'
        ? (view.HTMLInputElement || HTMLInputElement).prototype
        : null
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null
    if (setter) setter.call(el, cmd.text)
    else el.value = cmd.text
    fireInput()
  }
  el.blur()
  return JSON.stringify({ acted: true })
})()`

const READBACK_EXPRESSION = `(sel) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const el = deepQueryOne(document, sel)
  if (!el) return ''
  return el.isContentEditable ? (el.innerText || '').trim() : String(el.value ?? '')
})()`

// A dropdown is matched by its option value or label. Uses native prototype
// value setter from the element's own realm + composed input/change events.
const SELECT_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const el = deepQueryOne(document, cmd.selector)
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
  const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
  const EV = view.Event || Event
  const setter = Object.getOwnPropertyDescriptor((view.HTMLSelectElement || HTMLSelectElement).prototype, 'value')?.set
  if (setter) setter.call(el, match.value)
  else el.value = match.value
  el.dispatchEvent(new EV('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new EV('change', { bubbles: true, composed: true }))
  el.blur()
  return JSON.stringify({ acted: true, value: match.value, label: (match.textContent || '').trim() })
})()`

const SELECT_READBACK_EXPRESSION = `(sel) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const el = deepQueryOne(document, sel)
  if (!el) return ''
  const opt = el.selectedOptions && el.selectedOptions[0]
  return opt ? (opt.textContent || '').trim() : String(el.value ?? '')
})()`

// A targeted element query over light DOM + open Shadow DOM interactive controls.
const FIND_EXPRESSION = `(cmd) => (() => {
  const terms = String(cmd.q || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
  if (!terms.length) return JSON.stringify({ items: [], scanned: 0 })
  const collectInteractive = ${COLLECT_INTERACTIVE_EXPRESSION}
  const selectorFor = ${SELECTOR_FOR_EXPRESSION}
  const describe = ${ELEMENT_DESCRIPTOR_EXPRESSION}
  const scored = []
  let scanned = 0
  const root = document.body || document.documentElement
  for (const el of (root ? collectInteractive(root) : [])) {
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

// Reading one element's own words, supporting deep shadow selectors.
const TEXT_EXPRESSION = `(sel) => (() => {
  const deepQueryAll = ${DEEP_QUERY_ALL_EXPRESSION}
  let matches
  try { matches = deepQueryAll(document, sel) } catch { return JSON.stringify({ badSelector: true }) }
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

// Reading the whole page's visible text when page_text is called without a ref.
const FULL_PAGE_TEXT_EXPRESSION = `(() => {
  const body = document.body
  const text = body ? (body.innerText || body.textContent || '').trim() : ''
  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    text,
  })
})()`

const FOCUS_EXPRESSION = `(sel) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const el = deepQueryOne(document, sel)
  if (!el) return JSON.stringify({ focused: false })
  el.scrollIntoView({ block: 'center' })
  el.focus()
  return JSON.stringify({ focused: true })
})()`

// Graceful JS KeyboardEvent fallback when no CDP pressKey host is wired.
const DISPATCH_KEY_EXPRESSION = `(combo) => (() => {
  const raw = String(combo || '').trim()
  const parts = raw === '+' ? ['+'] : raw.split('+').map((p) => p.trim()).filter(Boolean)
  const main = parts[parts.length - 1] || raw
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()))
  const keyMap = {
    enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: ' ',
    arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
    arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  }
  const key = keyMap[main.toLowerCase()] || main
  let target = document.activeElement || document.body || document.documentElement
  while (target && target.shadowRoot && target.shadowRoot.activeElement) {
    target = target.shadowRoot.activeElement
  }
  if (!target) return JSON.stringify({ dispatched: false })
  const init = {
    key,
    code: key === ' ' ? 'Space' : key.length === 1 ? (/^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key) : key,
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: mods.has('alt') || mods.has('option'),
    ctrlKey: mods.has('control') || mods.has('ctrl'),
    metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
    shiftKey: mods.has('shift'),
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  if (key.length === 1 && !init.ctrlKey && !init.metaKey && !init.altKey) {
    target.dispatchEvent(new KeyboardEvent('keypress', init))
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return JSON.stringify({ dispatched: true, key })
})()`

const SCROLL_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const docEl = document.scrollingElement || document.documentElement || document.body
  const dir = cmd.direction || ''
  let target = null
  if (cmd.selector) {
    target = deepQueryOne(document, cmd.selector)
    if (!target) return JSON.stringify({ error: 'element not found' })
    const scrollable = target.scrollHeight > target.clientHeight + 2 || target.scrollWidth > target.clientWidth + 2
    if (!dir || !scrollable) {
      target.scrollIntoView({ block: 'center', inline: 'center' })
      if (!dir) {
        const maxScrollX = Math.max(0, (docEl?.scrollWidth || 0) - window.innerWidth)
        const maxScrollY = Math.max(0, (docEl?.scrollHeight || 0) - window.innerHeight)
        const scrollX = Math.round(window.scrollX || 0)
        const scrollY = Math.round(window.scrollY || 0)
        return JSON.stringify({
          scrollX,
          scrollY,
          maxScrollX: Math.round(maxScrollX),
          maxScrollY: Math.round(maxScrollY),
          viewportHeight: Math.round(window.innerHeight || 0),
          atTop: scrollY <= 1,
          atBottom: scrollY >= maxScrollY - 1,
        })
      }
      target = null
    }
  }
  const container = target || null
  const viewH = container ? container.clientHeight : (window.innerHeight || 600)
  const viewW = container ? container.clientWidth : (window.innerWidth || 800)
  const delta = Number.isFinite(cmd.amount) && cmd.amount > 0
    ? cmd.amount
    : Math.max(100, Math.round((dir === 'left' || dir === 'right' ? viewW : viewH) * 0.8))
  const maxY = container
    ? Math.max(0, container.scrollHeight - container.clientHeight)
    : Math.max(0, (docEl?.scrollHeight || 0) - window.innerHeight)
  const maxX = container
    ? Math.max(0, container.scrollWidth - container.clientWidth)
    : Math.max(0, (docEl?.scrollWidth || 0) - window.innerWidth)
  const doScrollBy = (dx, dy) => {
    if (container) { container.scrollLeft += dx; container.scrollTop += dy }
    else window.scrollBy(dx, dy)
  }
  const doScrollTo = (x, y) => {
    if (container) { container.scrollLeft = x; container.scrollTop = y }
    else window.scrollTo(x, y)
  }
  if (dir === 'up') doScrollBy(0, -delta)
  else if (dir === 'down') doScrollBy(0, delta)
  else if (dir === 'left') doScrollBy(-delta, 0)
  else if (dir === 'right') doScrollBy(delta, 0)
  else if (dir === 'top') doScrollTo(container ? container.scrollLeft : window.scrollX, 0)
  else if (dir === 'bottom') doScrollTo(container ? container.scrollLeft : window.scrollX, maxY)
  const scrollX = Math.round(container ? container.scrollLeft : (window.scrollX || 0))
  const scrollY = Math.round(container ? container.scrollTop : (window.scrollY || 0))
  const maxScrollX = Math.round(maxX)
  const maxScrollY = Math.round(maxY)
  return JSON.stringify({
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    viewportHeight: Math.round(viewH),
    atTop: scrollY <= 1,
    atBottom: scrollY >= maxScrollY - 1,
  })
})()`

const HOVER_TARGET_EXPRESSION = `(cmd) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const getViewportRect = ${GET_VIEWPORT_RECT_EXPRESSION}
  const scrollIntoViewDeep = ${SCROLL_INTO_VIEW_HELPER}
  const el = deepQueryOne(document, cmd.selector)
  if (!el) return JSON.stringify({ found: false })
  scrollIntoViewDeep(el)
  const vr = getViewportRect(el)
  const visible = vr.width > 0 || vr.height > 0
  const x = vr.left + vr.width / 2
  const y = vr.top + vr.height / 2
  if (visible && cmd.dispatchJs) {
    const lr = el.getBoundingClientRect()
    const lx = lr.left + lr.width / 2
    const ly = lr.top + lr.height / 2
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
    const PE = view.PointerEvent || PointerEvent
    const ME = view.MouseEvent || MouseEvent
    const init = { bubbles: true, cancelable: true, composed: true, clientX: lx, clientY: ly }
    el.dispatchEvent(new PE('pointerover', init))
    el.dispatchEvent(new PE('pointerenter', { ...init, bubbles: false }))
    el.dispatchEvent(new ME('mouseover', init))
    el.dispatchEvent(new ME('mouseenter', { ...init, bubbles: false }))
    el.dispatchEvent(new ME('mousemove', init))
  }
  return JSON.stringify({ found: true, visible, x, y })
})()`

const WAIT_CHECK_EXPRESSION = `(cmd) => (() => {
  const deepQueryAll = ${DEEP_QUERY_ALL_EXPRESSION}
  const isVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 && r.height <= 0) return false
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
    const style = view.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0
  }
  let matched = true
  if (cmd.url && !String(location.href || '').includes(cmd.url)) {
    matched = false
  }
  if (matched && cmd.text) {
    const body = document.body
    let content = body ? (body.innerText || body.textContent || '') : ''
    if (!content.includes(cmd.text)) {
      let foundInFrame = false
      for (const iframe of document.querySelectorAll('iframe, frame')) {
        let fdoc = null
        try { fdoc = iframe.contentDocument || null } catch { fdoc = null }
        if (fdoc && fdoc.body && (fdoc.body.innerText || fdoc.body.textContent || '').includes(cmd.text)) {
          foundInFrame = true
          break
        }
      }
      if (!foundInFrame) matched = false
    }
  }
  if (matched && cmd.selector) {
    let matches = []
    try { matches = deepQueryAll(document, cmd.selector) } catch { return JSON.stringify({ badSelector: true, url: location.href }) }
    const state = cmd.state || 'visible'
    if (state === 'attached') {
      matched = matches.length > 0
    } else if (state === 'hidden') {
      matched = matches.length === 0 || matches.every((el) => !isVisible(el))
    } else {
      matched = matches.some((el) => isVisible(el))
    }
  }
  return JSON.stringify({ matched, url: location.href })
})()`

const ELEMENT_CLIP_EXPRESSION = `(sel) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const getViewportRect = ${GET_VIEWPORT_RECT_EXPRESSION}
  const scrollIntoViewDeep = ${SCROLL_INTO_VIEW_HELPER}
  const el = deepQueryOne(document, sel)
  if (!el) return JSON.stringify({ found: false })
  scrollIntoViewDeep(el)
  const r = getViewportRect(el)
  if (r.width <= 0 || r.height <= 0) return JSON.stringify({ found: true, visible: false })
  return JSON.stringify({
    found: true,
    visible: true,
    clip: { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height },
  })
})()`

// Set-of-Marks visual overlay for annotated screenshots. Always removed in a
// finally block immediately after capture. Uses frame-accurate viewport rects
// so controls inside same-origin iframes get pixel-exact overlays too.
const INJECT_SOM_EXPRESSION = `(targets) => (() => {
  const deepQueryOne = ${DEEP_QUERY_ONE_EXPRESSION}
  const getViewportRect = ${GET_VIEWPORT_RECT_EXPRESSION}
  const existing = document.getElementById('__troy_som_overlay')
  if (existing) existing.remove()
  const container = document.createElement('div')
  container.id = '__troy_som_overlay'
  container.setAttribute('data-troy-som', '1')
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible;'
  const palette = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2']
  let count = 0
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    let el = null
    try { el = deepQueryOne(document, t.selector) } catch { continue }
    if (!el) continue
    const r = getViewportRect(el)
    if (r.width <= 0 || r.height <= 0) continue
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue
    const color = palette[i % palette.length]
    const box = document.createElement('div')
    box.style.cssText = [
      'position:fixed',
      'left:' + Math.round(r.left) + 'px',
      'top:' + Math.round(r.top) + 'px',
      'width:' + Math.round(r.width) + 'px',
      'height:' + Math.round(r.height) + 'px',
      'border:2px solid ' + color,
      'border-radius:3px',
      'box-sizing:border-box',
      'pointer-events:none',
    ].join(';')
    const badge = document.createElement('span')
    badge.textContent = t.ref
    badge.style.cssText = [
      'position:absolute',
      'left:-2px',
      'top:-18px',
      'background:' + color,
      'color:#fff',
      'font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:1px 4px',
      'border-radius:3px',
      'white-space:nowrap',
      'pointer-events:none',
    ].join(';')
    box.appendChild(badge)
    container.appendChild(box)
    count += 1
  }
  ;(document.body || document.documentElement)?.appendChild(container)
  return JSON.stringify({ annotatedCount: count, url: location.href, title: document.title || '' })
})()`

const REMOVE_SOM_EXPRESSION = `(() => {
  const el = document.getElementById('__troy_som_overlay')
  if (el) el.remove()
  return 'ok'
})()`

// Human-in-the-loop handoff banner. Uses textContent exclusively (never innerHTML)
// so untrusted text cannot inject markup. Always cleaned up in finally when waiting.
const INJECT_HANDOFF_BANNER_EXPRESSION = `(reason) => (() => {
  window.__troyHandoffResumed = false
  const existing = document.getElementById('troy-handoff-banner')
  if (existing) existing.remove()
  const bar = document.createElement('div')
  bar.id = 'troy-handoff-banner'
  bar.setAttribute('role', 'status')
  bar.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'gap:14px',
    'padding:12px 18px',
    'background:#0f172a',
    'color:#f8fafc',
    'border-bottom:2px solid #f59e0b',
    'box-shadow:0 8px 24px rgba(0,0,0,0.35)',
    'font:500 14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
  ].join(';')
  const left = document.createElement('div')
  left.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;'
  const badge = document.createElement('span')
  badge.textContent = 'ACTION NEEDED'
  badge.style.cssText = [
    'background:#f59e0b',
    'color:#0f172a',
    'font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:4px 7px',
    'border-radius:4px',
    'letter-spacing:0.04em',
    'flex-shrink:0',
  ].join(';')
  const msg = document.createElement('span')
  msg.textContent = String(reason || '')
  msg.style.cssText = 'color:#f8fafc;word-break:break-word;'
  left.appendChild(badge)
  left.appendChild(msg)
  const btn = document.createElement('button')
  btn.id = 'troy-handoff-resume'
  btn.type = 'button'
  btn.textContent = 'Resume Dexter'
  btn.style.cssText = [
    'background:#10b981',
    'color:#022c22',
    'border:none',
    'border-radius:6px',
    'padding:8px 14px',
    'font:700 13px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'cursor:pointer',
    'flex-shrink:0',
  ].join(';')
  btn.addEventListener('click', () => {
    window.__troyHandoffResumed = true
    bar.remove()
  })
  bar.appendChild(left)
  bar.appendChild(btn)
  ;(document.body || document.documentElement)?.appendChild(bar)
  return JSON.stringify({ url: location.href, title: document.title || '' })
})()`

const CHECK_HANDOFF_EXPRESSION = `(cmd) => (() => {
  const url = String(location.href || '')
  const title = String(document.title || '')
  if (window.__troyHandoffResumed === true) {
    return JSON.stringify({ resumedBy: 'user', url, title, hasBanner: Boolean(document.getElementById('troy-handoff-banner')) })
  }
  if (cmd.waitForUrl && url.includes(cmd.waitForUrl)) {
    return JSON.stringify({ resumedBy: 'url', url, title, hasBanner: Boolean(document.getElementById('troy-handoff-banner')) })
  }
  if (cmd.waitForText) {
    const body = document.body
    const content = body ? (body.innerText || body.textContent || '') : ''
    if (content.includes(cmd.waitForText)) {
      return JSON.stringify({ resumedBy: 'text', url, title, hasBanner: Boolean(document.getElementById('troy-handoff-banner')) })
    }
  }
  return JSON.stringify({ resumedBy: '', url, title, hasBanner: Boolean(document.getElementById('troy-handoff-banner')) })
})()`

const REMOVE_HANDOFF_BANNER_EXPRESSION = `(() => {
  const el = document.getElementById('troy-handoff-banner')
  if (el) el.remove()
  try { delete window.__troyHandoffResumed } catch {}
  return 'ok'
})()`

const PAGE_META_EXPRESSION = `(() => JSON.stringify({ url: location.href, title: document.title || '' }))()`

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
 * @property {(combo: string) => Promise<void>} [pressKey] dispatch a trusted CDP keyboard press
 * @property {(x: number, y: number) => Promise<void>} [hoverPoint] dispatch a trusted CDP mouse move
 * @property {(x: number, y: number, opts?: { button?: 'left' | 'right' | 'middle', clickCount?: number }) => Promise<void>} [clickPoint] dispatch a trusted CDP mouse click
 * @property {(fromX: number, fromY: number, toX: number, toY: number, steps?: number) => Promise<void>} [dragPoints] dispatch a trusted CDP mouse drag
 * @property {(selector: string, files: string[]) => Promise<void>} [setFileInputFiles] populate a file input via CDP DOM.setFileInputFiles
 * @property {(opts?: { action?: 'accept' | 'dismiss' | 'status', promptText?: string }) => Promise<Record<string, any>>} [handleDialog] inspect/arm/handle JS dialogs
 * @property {() => void | Promise<void>} [focusTab] show/focus the browser window and activate this tab
 * @property {(direction: 'back' | 'forward' | 'reload') => Promise<{ ok: boolean, url?: string, title?: string, error?: string }>} [history] navigate browser history
 * @property {(opts?: { fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } }) => Promise<{ mimeType: string, data: string, width?: number, height?: number }>} [screenshot] capture PNG screenshot
 * @property {(opts?: { clear?: boolean, level?: string, limit?: number }) => { count: number, entries: any[] } | Promise<{ count: number, entries: any[] }>} [getConsoleLogs] read per-tab console ring buffer
 * @property {(opts?: { clear?: boolean, failedOnly?: boolean, limit?: number }) => { count: number, entries: any[] } | Promise<{ count: number, entries: any[] }>} [getNetworkLogs] read per-tab network ring buffer
 */

/**
 * Check if a descriptor change is merely minor text/value drift on the exact
 * same control (same tag, type, role, action, submit/download/editable flags,
 * and matching strong identity anchor) rather than a swapped control.
 *
 * @param {Record<string, any>} expected
 * @param {Record<string, any>} current
 */
function isMinorTextDrift(expected, current) {
  if (!expected || !current) return false
  if (expected.tag !== current.tag) return false
  if (String(expected.type ?? '') !== String(current.type ?? '')) return false
  if (String(expected.role ?? '') !== String(current.role ?? '')) return false
  if (String(expected.href ?? '') !== String(current.href ?? '')) return false
  if (String(expected.formAction ?? '') !== String(current.formAction ?? '')) return false
  if (Boolean(expected.defaultSubmit) !== Boolean(current.defaultSubmit)) return false
  if (Boolean(expected.download) !== Boolean(current.download)) return false
  if (Boolean(expected.editable) !== Boolean(current.editable)) return false
  if (current.valueRedacted && !expected.valueRedacted) return false
  const sameId = Boolean(expected.id && current.id === expected.id)
  const sameName = Boolean(expected.name && current.name === expected.name)
  const sameAria = Boolean(expected.ariaLabel && current.ariaLabel === expected.ariaLabel)
  return sameId || sameName || sameAria
}

/**
 * Does a stored descriptor carry a deterministic anchor for stale-ref recovery?
 *
 * @param {Record<string, any> | null} expected
 */
function hasRecoveryAnchor(expected) {
  if (!expected) return false
  return Boolean(
    expected.id ||
    expected.ariaLabel ||
    (expected.name && expected.tag) ||
    (expected.role && expected.ariaLabel),
  )
}

/**
 * @param {ToolHost} host
 * @param {{
 *   elements?: import('./elements.js').ElementRegistry,
 *   authorize?: (request: { name: string, item?: Record<string, any>, targetUrl?: string, currentUrl?: string, allowSubmit?: boolean }) => import('./policy.js').PolicyDecision,
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
      ok: false,
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
   * @param {Map<string, Record<string, any>> | null} registeredBySelector
   */
  function diffRead(result, rawInteractive, registeredBySelector) {
    if (!lastRead || lastRead.url !== result.url) return null
    const current = new Map(rawInteractive.map((item) => [String(item.selector ?? ''), item]))
    const added = []
    const changed = []
    for (const [selector, item] of current) {
      const prior = lastRead.bySelector.get(selector)
      const publicItem = registeredBySelector?.get(selector) ?? item
      if (!prior) added.push(publicItem)
      else if (String(prior.signature ?? '') !== String(item.signature ?? '')) changed.push(publicItem)
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
    const boundedRaw = rawInteractive.slice(0, MAX_INTERACTIVE_ELEMENTS)
    /** @type {Map<string, Record<string, any>> | null} */
    let registeredBySelector = null
    if (Array.isArray(result.interactive)) {
      const reported = result.interactive.length
      result.interactive = boundedRaw
      if (options.elements && host.context) {
        const registered = options.elements.register(boundedRaw, host.context())
        result.interactive = registered
        registeredBySelector = new Map()
        for (let i = 0; i < boundedRaw.length; i++) {
          const sel = String(boundedRaw[i]?.selector ?? '')
          if (sel && registered[i]) registeredBySelector.set(sel, registered[i])
        }
      }
      // Shrink in one proportional step (was: halve-and-restringify per step,
      // O(n log n) serializations of the whole result on element-heavy pages).
      let serialized = JSON.stringify(result).length
      if (serialized > MAX_TOOL_RESULT_CHARS && result.interactive.length > 1) {
        const keep = Math.max(1, Math.floor(result.interactive.length * (MAX_TOOL_RESULT_CHARS / serialized) * 0.9))
        result.interactive = result.interactive.slice(0, keep)
        serialized = JSON.stringify(result).length
      }
      while (result.interactive.length > 1 && serialized > MAX_TOOL_RESULT_CHARS) {
        result.interactive = result.interactive.slice(0, Math.ceil(result.interactive.length / 2))
        serialized = JSON.stringify(result).length
      }
      if (reported > result.interactive.length || result.interactiveTruncated) {
        result.interactiveTruncated = true
        result.note = `interactive elements were limited to ${result.interactive.length}; refine the page before acting on controls not listed`
      }
    }
    options.memory?.recordRead?.(
      { url: String(result.url ?? host.context?.().url ?? ''), title: String(result.title ?? '') },
      { textPreview: result.textPreview, interactive: boundedRaw },
    )
    if (args?.since) {
      const delta = diffRead(result, boundedRaw, registeredBySelector)
      if (delta) {
        lastRead = {
          url: String(result.url ?? ''),
          textPreview: String(result.textPreview ?? ''),
          bySelector: new Map(boundedRaw.map((item) => [String(item.selector ?? ''), item])),
        }
        return capResult({ url: result.url, title: result.title, ...delta })
      }
    }
    lastRead = {
      url: String(result.url ?? ''),
      textPreview: String(result.textPreview ?? ''),
      bySelector: new Map(boundedRaw.map((item) => [String(item.selector ?? ''), item])),
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
   * Shared inspection: resolve the selector, refuse ambiguity, attempt
   * deterministic stale-ref recovery when a registered ref lost its selector or
   * experienced minor text drift on the same control, then hand the single
   * match back. Every refusal here happens before anything that could change
   * the page.
   */
  async function inspectOne(/** @type {any} */ args) {
    let selector = String(args.selector ?? '')
    /** @type {Record<string, any> | null} */
    let expected = null
    /** @type {{ tabId: number, url: string, epoch: number } | null} */
    let ctx = null
    if (options.elements) {
      if (!host.context) return { error: 'this host cannot resolve element references' }
      ctx = host.context()
      const resolved = options.elements.resolve(args.ref, ctx)
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
      if (options.elements && ctx && hasRecoveryAnchor(expected)) {
        const recovered = await evalJson(
          `(${RECOVER_ELEMENT_EXPRESSION})(${JSON.stringify({
            id: expected?.id ?? '',
            ariaLabel: expected?.ariaLabel ?? '',
            name: expected?.name ?? '',
            tag: expected?.tag ?? '',
            role: expected?.role ?? '',
          })})`,
        ).catch(() => ({ found: false }))
        if (recovered?.found && recovered.selector && recovered.item) {
          options.elements.update(String(args.ref), recovered.selector, recovered.item, ctx)
          return { item: recovered.item, selector: recovered.selector, recovered: true }
        }
      }
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
      if (options.elements && ctx && isMinorTextDrift(expected, current)) {
        options.elements.update(String(args.ref), selector, current, ctx)
        return { item: current, selector, recovered: true }
      }
      options.elements?.invalidate()
      return { error: `${label} now points to a different control; read the page again` }
    }
    return { item: current, selector }
  }

  async function pageClick(/** @type {any} */ args) {
    const button = args.button !== undefined ? String(args.button).toLowerCase() : 'left'
    if (!['left', 'right', 'middle'].includes(button)) {
      return { error: `invalid click button "${button}"; use left, right, or middle` }
    }
    const clickCount = args.clickCount !== undefined ? Number(args.clickCount) : 1
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
      return { error: 'clickCount must be an integer between 1 and 3' }
    }
    const hasTarget = options.elements ? args.ref !== undefined : args.selector !== undefined
    const hasCoords = args.x !== undefined || args.y !== undefined

    // Coordinate click for canvas/OCR regions when no ref/selector is given
    if (!hasTarget && hasCoords) {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { error: 'coordinate click requires finite numeric x and y' }
      }
      if (options.authorize) {
        const currentUrl = String(host.context?.().url ?? '')
        const denied = refusal(options.authorize({ name: 'page_click', currentUrl }))
        if (denied) return denied
      }
      assertNotAborted()
      const typedButton = /** @type {'left' | 'right' | 'middle'} */ (button)
      if (host.clickPoint) {
        await host.clickPoint(x, y, { button: typedButton, clickCount })
      } else {
        await evalJson(`(${CLICK_COORD_JS_EXPRESSION})(${JSON.stringify({ x, y, button: typedButton, clickCount })})`)
      }
      await host.settle()
      if (options.authorize && host.context) {
        const boundary = refusal(options.authorize({ name: 'page_navigate', targetUrl: host.context().url }))
        if (boundary) return boundary
      }
      return {
        ok: true,
        x: Math.round(x),
        y: Math.round(y),
        button: typedButton,
        clickCount,
      }
    }

    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    const allowSubmit = args.allowSubmit === true
    if (item.disabled) return { error: `that control is disabled` }
    if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_click', item, allowSubmit }))
      if (denied) return denied
    }
    if (!allowSubmit && SUBMIT_PATTERN.test(item.text)) {
      return {
        ok: false,
        blocked: true,
        code: 'submit',
        error: `"${item.text}" reads like a submit or commit action, which is always yours to click`,
      }
    }
    if (!allowSubmit && item.defaultSubmit) {
      return {
        ok: false,
        blocked: true,
        code: 'submit',
        error: `that button would submit its form, which is always yours to click`,
      }
    }

    const before = await evalJson(SNAPSHOT_EXPRESSION)
    assertNotAborted()
    const typedButton = /** @type {'left' | 'right' | 'middle'} */ (button)
    if (host.clickPoint) {
      const prep = await evalJson(
        `(${CLICK_PREPARE_EXPRESSION})(${JSON.stringify({ selector, button: typedButton, clickCount })})`,
      )
      if (!prep?.found) return { error: 'element is no longer on the page' }
      if (prep.visible) {
        await host.clickPoint(Number(prep.x), Number(prep.y), { button: typedButton, clickCount })
      } else if (!prep.acted) {
        await host.evaluate(`(${CLICK_EXPRESSION})(${JSON.stringify({ selector, button: typedButton, clickCount })})`)
      }
    } else {
      await host.evaluate(`(${CLICK_EXPRESSION})(${JSON.stringify({ selector, button: typedButton, clickCount })})`)
    }
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
        ...(typedButton !== 'left' ? { button: typedButton } : {}),
        ...(clickCount !== 1 ? { clickCount } : {}),
      }
    }
    return {
      ok: true,
      changed: true,
      pageChanged: true,
      reasons,
      ...(typedButton !== 'left' ? { button: typedButton } : {}),
      ...(clickCount !== 1 ? { clickCount } : {}),
    }
  }

  async function pageDrag(/** @type {any} */ args) {
    const currentUrl = String(host.context?.().url ?? '')
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_drag', currentUrl }))
      if (denied) return denied
    }
    const steps = Math.min(Math.max(Math.round(Number(args.steps ?? 10) || 10), 1), 60)

    let fromX = Number(args.fromX)
    let fromY = Number(args.fromY)
    let fromSelector = ''
    const hasFromTarget = options.elements ? args.fromRef !== undefined : args.fromSelector !== undefined
    if (hasFromTarget) {
      const found = await inspectOne(options.elements ? { ref: args.fromRef } : { selector: args.fromSelector })
      if ('error' in found) return found
      const item = /** @type {InspectItem} */ (found.item)
      fromSelector = String(found.selector ?? args.fromSelector ?? '')
      if (item.disabled) return { error: 'the drag source control is disabled' }
      if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
      if (options.authorize) {
        const denied = refusal(options.authorize({ name: 'page_drag', item, currentUrl }))
        if (denied) return denied
      }
      const center = await evalJson(`(${ELEMENT_CENTER_EXPRESSION})(${JSON.stringify(fromSelector)})`)
      if (!center?.found || !center?.visible) return { error: 'drag source element is not visible' }
      fromX = Number(center.x)
      fromY = Number(center.y)
    } else if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) {
      return { error: 'page_drag requires fromRef (or fromSelector) or finite fromX and fromY' }
    }

    let toX = Number(args.toX)
    let toY = Number(args.toY)
    let toSelector = ''
    const hasToTarget = options.elements ? args.toRef !== undefined : args.toSelector !== undefined
    if (hasToTarget) {
      const found = await inspectOne(options.elements ? { ref: args.toRef } : { selector: args.toSelector })
      if ('error' in found) return found
      const item = /** @type {InspectItem} */ (found.item)
      toSelector = String(found.selector ?? args.toSelector ?? '')
      if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
      if (options.authorize) {
        const denied = refusal(options.authorize({ name: 'page_drag', item, currentUrl }))
        if (denied) return denied
      }
      const center = await evalJson(`(${ELEMENT_CENTER_EXPRESSION})(${JSON.stringify(toSelector)})`)
      if (!center?.found || !center?.visible) return { error: 'drag target element is not visible' }
      toX = Number(center.x)
      toY = Number(center.y)
    } else if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
      return { error: 'page_drag requires toRef (or toSelector) or finite toX and toY' }
    }

    assertNotAborted()
    if (host.dragPoints) {
      await host.dragPoints(fromX, fromY, toX, toY, steps)
    } else {
      await evalJson(
        `(${DRAG_JS_EXPRESSION})(${JSON.stringify({
          fromSelector: fromSelector || undefined,
          toSelector: toSelector || undefined,
          fromX,
          fromY,
          toX,
          toY,
          steps,
        })})`,
      )
    }
    await host.settle()
    return {
      ok: true,
      from: { x: Math.round(fromX), y: Math.round(fromY) },
      to: { x: Math.round(toX), y: Math.round(toY) },
      steps,
    }
  }

  async function pageUpload(/** @type {any} */ args) {
    const validated = validateUploadFiles(args.files)
    if (!validated.ok) {
      return {
        ok: false,
        ...(validated.blocked ? { blocked: true } : {}),
        ...(validated.code ? { code: validated.code } : {}),
        error: validated.error,
      }
    }
    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    if (item.disabled) return { error: 'that file input is disabled' }
    if (item.tag !== 'input' || String(item.type || '').toLowerCase() !== 'file') {
      return { error: `<${item.tag}> is not a file input; page_upload only operates <input type="file"> elements` }
    }
    if (options.authorize) {
      const currentUrl = String(host.context?.().url ?? '')
      const denied = refusal(options.authorize({ name: 'page_upload', item, currentUrl }))
      if (denied) return denied
    }
    if (validated.files.length > 1 && item.multiple === false) {
      return { error: `that file input does not accept multiple files (${validated.files.length} given)` }
    }
    if (!host.setFileInputFiles) {
      return { error: 'file upload is unavailable in this host' }
    }
    assertNotAborted()
    await host.setFileInputFiles(selector, validated.files)
    await host.settle()
    return {
      ok: true,
      files: validated.files.map((f) => path.basename(f)),
      count: validated.files.length,
    }
  }

  async function pageDialog(/** @type {any} */ args) {
    const action = args.action !== undefined ? String(args.action).toLowerCase() : 'status'
    if (!['accept', 'dismiss', 'status'].includes(action)) {
      return { error: `invalid dialog action "${action}"; use accept, dismiss, or status` }
    }
    if (!host.handleDialog) {
      return { error: 'dialog handling is unavailable in this host' }
    }
    assertNotAborted()
    const typedAction = /** @type {'accept' | 'dismiss' | 'status'} */ (action)
    return host.handleDialog({
      action: typedAction,
      ...(args.promptText !== undefined ? { promptText: String(args.promptText) } : {}),
    })
  }

  async function pageHandoff(/** @type {any} */ args) {
    const reason = String(args.reason ?? '').trim()
    if (!reason) {
      return { error: 'page_handoff requires a reason explaining what the human should do' }
    }
    assertNotAborted()
    if (host.focusTab) {
      try {
        await host.focusTab()
      } catch {
        // Window focus is best-effort in headless environments.
      }
    }
    const meta = await evalJson(`(${INJECT_HANDOFF_BANNER_EXPRESSION})(${JSON.stringify(reason)})`)
    const initialUrl = String(meta?.url ?? host.context?.().url ?? '')
    const initialTitle = String(meta?.title ?? '')

    if (args.wait === false) {
      return {
        ok: true,
        waiting: false,
        reason,
        url: initialUrl,
        title: initialTitle,
      }
    }

    const startedAt = Date.now()
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 120_000) || 120_000, 100), 300_000)
    const deadline = startedAt + timeoutMs
    const waitForUrl = args.waitForUrl !== undefined ? String(args.waitForUrl) : ''
    const waitForText = args.waitForText !== undefined ? String(args.waitForText) : ''
    let lastUrl = initialUrl
    let lastTitle = initialTitle

    try {
      while (true) {
        assertNotAborted()
        let check = null
        try {
          check = await evalJson(
            `(${CHECK_HANDOFF_EXPRESSION})(${JSON.stringify({ waitForUrl, waitForText })})`,
          )
        } catch {
          // Page may be mid-navigation during human interaction; retry until deadline.
          check = null
        }
        if (check && typeof check === 'object') {
          if (check.url) lastUrl = String(check.url)
          if (check.title !== undefined) lastTitle = String(check.title)
          if (check.resumedBy) {
            await host.settle().catch(() => undefined)
            if (lastUrl && lastUrl !== initialUrl) {
              options.elements?.invalidate()
              host.invalidate?.()
            }
            return {
              ok: true,
              resumedBy: String(check.resumedBy),
              elapsedMs: Date.now() - startedAt,
              url: lastUrl,
              title: lastTitle,
            }
          }
          // If the human navigated to a new page before finishing, re-show the banner.
          if (check.hasBanner === false) {
            await evalJson(`(${INJECT_HANDOFF_BANNER_EXPRESSION})(${JSON.stringify(reason)})`).catch(() => undefined)
          }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return {
            ok: false,
            error: 'handoff timed out',
            elapsedMs: Date.now() - startedAt,
            url: lastUrl,
            title: lastTitle,
          }
        }
        await sleep(Math.min(150, remaining), options.signal)
      }
    } finally {
      await host.evaluate(REMOVE_HANDOFF_BANNER_EXPRESSION).catch(() => undefined)
    }
  }

  async function pageFill(/** @type {any} */ args) {
    const hasText = typeof args.text === 'string'
    const hasValue = typeof args.value === 'string'
    const clearing = args.clear === true || (hasText && args.text === '') || (!hasText && hasValue && args.value === '')
    const text = hasText ? args.text : hasValue ? args.value : ''
    if (!clearing && !text.trim()) {
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
    const hasTarget = options.elements ? args.ref !== undefined : args.selector !== undefined
    if (!hasTarget) {
      const full = await evalJson(FULL_PAGE_TEXT_EXPRESSION)
      const rawText = String(full?.text ?? '')
      const maxChars = MAX_TOOL_RESULT_CHARS - 1000
      const truncated = rawText.length > maxChars
      return {
        ok: true,
        text: truncated ? rawText.slice(0, maxChars) : rawText,
        url: String(full?.url ?? host.context?.().url ?? ''),
        title: String(full?.title ?? ''),
        truncated,
      }
    }
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

  async function pagePress(/** @type {any} */ args) {
    const key = String(args.key ?? '').trim()
    if (!key) return { error: 'no key given; pass a key or combo such as Enter, Escape, or Control+A' }
    const hasTarget = options.elements ? args.ref !== undefined : args.selector !== undefined
    if (hasTarget) {
      const found = await inspectOne(args)
      if ('error' in found) return found
      const item = /** @type {InspectItem} */ (found.item)
      const selector = String(found.selector ?? args.selector ?? '')
      if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
      if (options.authorize) {
        const denied = refusal(options.authorize({ name: 'page_press', item }))
        if (denied) return denied
      }
      await evalJson(`(${FOCUS_EXPRESSION})(${JSON.stringify(selector)})`)
    }
    assertNotAborted()
    if (host.pressKey) {
      await host.pressKey(key)
    } else {
      await evalJson(`(${DISPATCH_KEY_EXPRESSION})(${JSON.stringify(key)})`)
    }
    await host.settle()
    if (options.authorize && host.context) {
      const boundary = refusal(options.authorize({ name: 'page_navigate', targetUrl: host.context().url }))
      if (boundary) return boundary
    }
    return { ok: true, key, ...(options.elements && args.ref ? { ref: String(args.ref) } : {}) }
  }

  async function pageScroll(/** @type {any} */ args) {
    const validDirections = new Set(['up', 'down', 'left', 'right', 'top', 'bottom'])
    const hasTarget = options.elements ? args.ref !== undefined : args.selector !== undefined
    const direction = args.direction !== undefined ? String(args.direction).toLowerCase() : hasTarget ? '' : 'down'
    if (direction && !validDirections.has(direction)) {
      return { error: `invalid scroll direction "${direction}"; use up, down, left, right, top, or bottom` }
    }
    let selector = ''
    if (hasTarget) {
      const found = await inspectOne(args)
      if ('error' in found) return found
      selector = String(found.selector ?? args.selector ?? '')
    }
    const amount = args.amount !== undefined ? Number(args.amount) : undefined
    const metrics = await evalJson(
      `(${SCROLL_EXPRESSION})(${JSON.stringify({ direction, amount, selector: selector || undefined })})`,
    )
    if (metrics?.error) return { error: String(metrics.error) }
    return {
      ok: true,
      scrollX: Number(metrics?.scrollX ?? 0),
      scrollY: Number(metrics?.scrollY ?? 0),
      maxScrollX: Number(metrics?.maxScrollX ?? 0),
      maxScrollY: Number(metrics?.maxScrollY ?? 0),
      viewportHeight: Number(metrics?.viewportHeight ?? 0),
      atTop: Boolean(metrics?.atTop),
      atBottom: Boolean(metrics?.atBottom),
    }
  }

  async function pageHover(/** @type {any} */ args) {
    const found = await inspectOne(args)
    if ('error' in found) return found
    const item = /** @type {InspectItem} */ (found.item)
    const selector = String(found.selector ?? args.selector ?? '')
    if (item.type === 'password') return { error: 'password fields are never operated by the agent' }
    if (options.authorize) {
      const denied = refusal(options.authorize({ name: 'page_hover', item }))
      if (denied) return denied
    }
    const target = await evalJson(
      `(${HOVER_TARGET_EXPRESSION})(${JSON.stringify({ selector, dispatchJs: !host.hoverPoint })})`,
    )
    if (!target?.found) return { error: 'element is no longer on the page' }
    if (!target.visible) return { error: 'that element is not visible to hover' }
    assertNotAborted()
    if (host.hoverPoint) {
      await host.hoverPoint(Number(target.x), Number(target.y))
    }
    await host.settle()
    return {
      ok: true,
      x: Math.round(Number(target.x)),
      y: Math.round(Number(target.y)),
      ...(options.elements && args.ref ? { ref: String(args.ref) } : {}),
    }
  }

  async function pageWait(/** @type {any} */ args) {
    const text = args.text !== undefined ? String(args.text) : ''
    const selector = args.selector !== undefined ? String(args.selector) : ''
    const state = args.state !== undefined ? String(args.state) : 'visible'
    const url = args.url !== undefined ? String(args.url) : ''
    const hasMs = args.ms !== undefined && args.ms !== null
    const ms = hasMs ? Math.min(Math.max(Number(args.ms) || 0, 0), MAX_WAIT_MS) : 0

    if (!text && !selector && !url && !hasMs) {
      return { error: 'page_wait needs at least one of text, selector, url, or ms' }
    }
    if (selector && !['visible', 'hidden', 'attached'].includes(state)) {
      return { error: `invalid wait state "${state}"; use visible, hidden, or attached` }
    }

    const startedAt = Date.now()
    if (!text && !selector && !url) {
      await sleep(ms, options.signal)
      return {
        ok: true,
        matched: true,
        elapsedMs: Date.now() - startedAt,
        url: String(host.context?.().url ?? ''),
      }
    }

    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 10000) || 10000, 100), MAX_WAIT_MS)
    const deadline = startedAt + timeoutMs
    let lastUrl = String(host.context?.().url ?? '')

    while (true) {
      assertNotAborted()
      const check = await evalJson(
        `(${WAIT_CHECK_EXPRESSION})(${JSON.stringify({ text, selector, state, url })})`,
      )
      if (check?.url) lastUrl = String(check.url)
      if (check?.badSelector) {
        return { error: `wait selector "${selector}" is not a valid selector` }
      }
      if (check?.matched) {
        return {
          ok: true,
          matched: true,
          elapsedMs: Date.now() - startedAt,
          url: lastUrl,
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return {
          ok: false,
          matched: false,
          elapsedMs: Date.now() - startedAt,
          url: lastUrl,
          error: `timed out after ${timeoutMs}ms waiting for condition`,
        }
      }
      await sleep(Math.min(100, remaining), options.signal)
    }
  }

  async function pageScreenshot(/** @type {any} */ args) {
    if (!host.screenshot) return { error: 'screenshots are unavailable in this host' }
    assertNotAborted()
    const fullPage = Boolean(args.fullPage)
    const annotate = Boolean(args.annotate)
    const hasTarget = options.elements ? args.ref !== undefined : args.selector !== undefined
    /** @type {{ x: number, y: number, width: number, height: number } | undefined} */
    let clip
    if (hasTarget) {
      const found = await inspectOne(args)
      if ('error' in found) return found
      const selector = String(found.selector ?? args.selector ?? '')
      const rectRes = await evalJson(`(${ELEMENT_CLIP_EXPRESSION})(${JSON.stringify(selector)})`)
      if (!rectRes?.found || !rectRes?.visible || !rectRes?.clip) {
        return { error: 'target element is not visible to screenshot' }
      }
      clip = rectRes.clip
    }

    let annotatedCount
    let meta = { url: String(host.context?.().url ?? ''), title: '' }
    if (annotate) {
      /** @type {Array<{ ref: string, selector: string }>} */
      let targets = []
      if (options.elements && host.context) {
        let entries = options.elements.list(host.context())
        if (entries.length === 0) {
          await pageRead({})
          entries = options.elements.list(host.context())
        }
        targets = entries.map((e) => ({ ref: e.ref, selector: e.selector }))
      }
      const injected = await evalJson(`(${INJECT_SOM_EXPRESSION})(${JSON.stringify(targets)})`)
      annotatedCount = Number(injected?.annotatedCount ?? 0)
      meta = { url: String(injected?.url ?? meta.url), title: String(injected?.title ?? '') }
      try {
        const shot = await host.screenshot({ fullPage, clip })
        return {
          ok: true,
          mimeType: shot.mimeType || 'image/png',
          data: shot.data,
          ...(shot.width !== undefined ? { width: shot.width } : {}),
          ...(shot.height !== undefined ? { height: shot.height } : {}),
          url: meta.url,
          title: meta.title,
          annotatedCount,
        }
      } finally {
        await host.evaluate(REMOVE_SOM_EXPRESSION).catch(() => undefined)
      }
    }

    const shot = await host.screenshot({ fullPage, clip })
    try {
      const pageMeta = await evalJson(PAGE_META_EXPRESSION)
      if (pageMeta && typeof pageMeta === 'object') {
        meta = { url: String(pageMeta.url ?? meta.url), title: String(pageMeta.title ?? '') }
      }
    } catch {
      // Meta lookup is best-effort when host.evaluate is not scripted for screenshots.
    }
    return {
      ok: true,
      mimeType: shot.mimeType || 'image/png',
      data: shot.data,
      ...(shot.width !== undefined ? { width: shot.width } : {}),
      ...(shot.height !== undefined ? { height: shot.height } : {}),
      url: meta.url,
      title: meta.title,
    }
  }

  async function pageHistory(/** @type {any} */ args) {
    const direction = String(args.direction ?? '').toLowerCase()
    if (!['back', 'forward', 'reload'].includes(direction)) {
      return { error: `invalid history direction "${direction}"; use back, forward, or reload` }
    }
    if (!host.history) return { error: 'history navigation is unavailable in this host' }
    assertNotAborted()
    const res = await host.history(/** @type {'back' | 'forward' | 'reload'} */ (direction))
    options.elements?.invalidate()
    host.invalidate?.()
    if (!res?.ok) {
      return { ok: false, error: res?.error ?? `history ${direction} failed`, url: res?.url ?? '' }
    }
    const targetUrl = String(res.url ?? host.context?.().url ?? '')
    if (options.authorize && targetUrl) {
      const boundary = refusal(options.authorize({ name: 'page_navigate', targetUrl }))
      if (boundary) return boundary
    }
    return { ok: true, direction, url: targetUrl, title: String(res.title ?? '') }
  }

  async function pageConsole(/** @type {any} */ args) {
    if (!host.getConsoleLogs) return { error: 'console logs are unavailable in this host' }
    const level = args.level !== undefined ? String(args.level).toLowerCase() : 'all'
    if (!['all', 'error', 'warning', 'log'].includes(level)) {
      return { error: `invalid console level "${level}"; use all, error, warning, or log` }
    }
    const res = await host.getConsoleLogs({
      clear: Boolean(args.clear),
      level,
      limit: args.limit !== undefined ? Number(args.limit) : undefined,
    })
    const entries = Array.isArray(res?.entries) ? res.entries : []
    return { ok: true, count: Number(res?.count ?? entries.length), entries }
  }

  async function pageNetwork(/** @type {any} */ args) {
    if (!host.getNetworkLogs) return { error: 'network logs are unavailable in this host' }
    const res = await host.getNetworkLogs({
      clear: Boolean(args.clear),
      failedOnly: Boolean(args.failedOnly),
      limit: args.limit !== undefined ? Number(args.limit) : undefined,
    })
    const entries = Array.isArray(res?.entries) ? res.entries : []
    return { ok: true, count: Number(res?.count ?? entries.length), entries }
  }

  async function pageEval(/** @type {any} */ args) {
    const expression = String(args.expression ?? '').trim()
    if (!expression) return { error: 'no expression given to page_eval' }
    if (options.authorize) {
      const currentUrl = String(host.context?.().url ?? '')
      const denied = refusal(options.authorize({ name: 'page_eval', currentUrl }))
      if (denied) return denied
    }
    assertNotAborted()
    const wrapped = `(() => {
      const __v = (0, eval)(${JSON.stringify(`(${expression})`)})
      const __pack = (r) => JSON.stringify({ value: r === undefined ? null : r })
      return __v && typeof __v.then === 'function' ? __v.then(__pack) : __pack(__v)
    })()`
    let raw
    try {
      raw = await host.evaluate(wrapped)
    } catch {
      // Fallback for statements (not single expressions), e.g. `const x = 1; return x;`
      const stmtWrapped = `(() => {
        const __v = (function() { ${expression} })()
        const __pack = (r) => JSON.stringify({ value: r === undefined ? null : r })
        return __v && typeof __v.then === 'function' ? __v.then(__pack) : __pack(__v)
      })()`
      raw = await host.evaluate(stmtWrapped)
    }
    assertNotAborted()
    let value
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        value = parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed
      } catch {
        value = raw
      }
    } else if (raw && typeof raw === 'object' && 'value' in /** @type {Record<string, any>} */ (raw)) {
      value = /** @type {Record<string, any>} */ (raw).value
    } else {
      value = raw
    }
    return capResult({ ok: true, value })
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
    if (Array.isArray(before.states) && Array.isArray(after.states)) {
      if (JSON.stringify(before.states) !== JSON.stringify(after.states)) {
        reasons.push('control toggle/open state changed')
      }
    }
    if (before.active !== undefined && after.active !== undefined && before.active !== after.active) {
      reasons.push(`focus moved to ${after.active || 'document'}`)
    }
    if (before.elementCount !== undefined && after.elementCount !== undefined && before.elementCount !== after.elementCount) {
      reasons.push(`DOM element count changed by ${after.elementCount - before.elementCount}`)
    }
    if (after.textLen !== before.textLen) {
      reasons.push(`page text length changed by ${after.textLen - before.textLen}`)
    } else if (before.textHash !== undefined && after.textHash !== undefined && before.textHash !== after.textHash) {
      reasons.push('page text content changed')
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
   * What the memory graph already knows. Keeps existing fields intact, and when
   * ElementRegistry + live page evaluation are available, binds matching live
   * DOM selectors so recalled elements include actionable `ref` handles.
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
    if (
      options.elements &&
      host.context &&
      Array.isArray(result?.elements) &&
      result.elements.length > 0
    ) {
      const selectors = result.elements
        .map((/** @type {any} */ el) => String(el?.selector ?? ''))
        .filter(Boolean)
      const registry = options.elements
      if (selectors.length > 0 && registry) {
        try {
          const bound = await evalJson(`(${RECALL_BIND_EXPRESSION})(${JSON.stringify(selectors)})`)
          if (bound && typeof bound === 'object') {
            const ctx = host.context()
            const enriched = result.elements.map((/** @type {any} */ el) => {
              const sel = String(el?.selector ?? '')
              const live = sel ? bound[sel] : null
              if (!live) return el
              const [registered] = registry.add([live], ctx)
              return { ...el, ref: registered.ref }
            })
            return capResult({ ...result, elements: enriched })
          }
        } catch {
          // If live evaluation is unavailable (e.g. blank tab or scripted unit test),
          // return recalled memory cleanly without failing.
        }
      }
    }
    return capResult(result)
  }

  /**
   * Several actions in one call. Each op passes through the same guards the
   * standalone tools apply; the first refusal stops the sequence, because
   * continuing a recipe past a refusal is worse than stopping early.
   */
  async function pageAct(/** @type {any} */ args) {
    const ops = Array.isArray(args.ops) ? args.ops : Array.isArray(args.steps) ? args.steps : []
    if (ops.length === 0) return { error: 'nothing to do; ops is an empty list' }
    if (ops.length > MAX_ACT_OPS) return { error: `a batch is limited to ${MAX_ACT_OPS} operations` }
    const batchAllowSubmit = args.allowSubmit === true
    const dispatch = /** @type {Record<string, (a: any) => Promise<any>>} */ ({
      click: (op) => pageClick({ ...op, allowSubmit: op.allowSubmit ?? batchAllowSubmit }),
      drag: pageDrag,
      fill: pageFill,
      select: pageSelect,
      text: pageText,
      read: (op) => pageRead(op),
      press: pagePress,
      hover: pageHover,
      scroll: pageScroll,
      wait: pageWait,
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
    page_drag: pageDrag,
    page_upload: pageUpload,
    page_dialog: pageDialog,
    page_handoff: pageHandoff,
    page_fill: pageFill,
    page_select: pageSelect,
    page_press: pagePress,
    page_scroll: pageScroll,
    page_hover: pageHover,
    page_wait: pageWait,
    page_screenshot: pageScreenshot,
    page_history: pageHistory,
    page_console: pageConsole,
    page_network: pageNetwork,
    page_eval: pageEval,
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
        ? 'Read facts about the active tab and its interactive elements (including ARIA controls and open Shadow DOM). Read before acting; use only the opaque element refs returned by the latest read. Pass since to get back only what changed.'
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
      description: 'Recall what this browser already learned about pages and controls, without reading the page again. Returns matching elements (with live refs when present on the current page), matching pages, and recorded paths.',
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
      description: 'Run several actions in order (click/drag/fill/select/text/read/press/hover/scroll/wait) as one call. The first error or refusal stops the sequence.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            items: { type: 'object' },
            description: 'ordered operations: {op, ref|selector, text|value|key|direction|button|clickCount|fromRef|toRef|...}',
          },
          allowSubmit: {
            type: 'boolean',
            description: 'explicitly permit submit/commit clicks after human confirmation',
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
        ? 'Read the exact visible text of one element by ref, or omit ref to read the full visible page text.'
        : 'Read the exact visible text of one element by selector, or omit selector to read the full visible page text.',
      gated: false,
      input: { type: 'object', properties: elementProperty },
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
        ? 'Click one element ref from the latest page_read (supports left/right/middle button and double-click), or pass numeric viewport coordinates (x, y) for canvas/OCR regions. Irreversible controls are blocked unless allowSubmit is explicitly true.'
        : 'Click one element by selector (supports left/right/middle button and double-click), or pass numeric viewport coordinates (x, y). Submit-shaped controls are refused unless allowSubmit is true.',
      gated: true,
      input: {
        type: 'object',
        properties: options.elements
          ? {
              ...elementProperty,
              x: { type: 'number', description: 'viewport X coordinate (for coordinate click without ref)' },
              y: { type: 'number', description: 'viewport Y coordinate (for coordinate click without ref)' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              clickCount: { type: 'integer', description: 'number of clicks (1 for single, 2 for double-click)' },
              allowSubmit: { type: 'boolean', description: 'explicitly permit submit/commit click after human confirmation' },
            }
          : {
              ...elementProperty,
              within: { type: 'string', description: 'optional container to scope the selector' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              clickCount: { type: 'integer' },
              allowSubmit: { type: 'boolean' },
            },
      },
    },
    {
      name: 'page_drag',
      description: 'Drag from a source element ref (or fromX/fromY coordinates) to a target element ref (or toX/toY coordinates) in smooth interpolated pointer steps.',
      gated: true,
      input: {
        type: 'object',
        properties: options.elements
          ? {
              fromRef: { type: 'string', description: 'source element ref' },
              toRef: { type: 'string', description: 'target element ref' },
              fromX: { type: 'number' },
              fromY: { type: 'number' },
              toX: { type: 'number' },
              toY: { type: 'number' },
              steps: { type: 'integer', description: 'number of interpolated move steps (default 10)' },
            }
          : {
              fromSelector: { type: 'string' },
              toSelector: { type: 'string' },
              fromX: { type: 'number' },
              fromY: { type: 'number' },
              toX: { type: 'number' },
              toY: { type: 'number' },
              steps: { type: 'integer' },
            },
      },
    },
    {
      name: 'page_upload',
      description: 'Safely attach one or more local regular files to an <input type="file"> element after strict path-safety validation (sensitive secret paths are hard-blocked).',
      gated: true,
      input: {
        type: 'object',
        properties: {
          ...elementProperty,
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'local file paths to attach (max 20 regular files)',
          },
        },
        required: [elementKey, 'files'],
      },
    },
    {
      name: 'page_dialog',
      description: 'Inspect JavaScript dialog history or arm/handle alert, confirm, and prompt dialogs without deadlocking.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'dismiss', 'status'] },
          promptText: { type: 'string', description: 'text to supply when accepting a prompt() dialog' },
        },
      },
    },
    {
      name: 'page_handoff',
      description: 'Focus the Troy browser window and display a human-in-the-loop banner (e.g. for CAPTCHA, 2FA, or payment confirmation), optionally waiting until the human clicks Resume Dexter or a URL/text condition is met.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'plain-language explanation of what the human needs to complete' },
          wait: { type: 'boolean', description: 'whether to block until resumed (default true)' },
          waitForUrl: { type: 'string', description: 'resume automatically when URL contains this substring' },
          waitForText: { type: 'string', description: 'resume automatically when page text contains this substring' },
          timeoutMs: { type: 'number', description: 'maximum wait in ms (default 120000, max 300000)' },
        },
        required: ['reason'],
      },
    },
    {
      name: 'page_fill',
      description: options.elements
        ? 'Fill or clear one ordinary text field ref from the latest page_read, then verify it. Sensitive fields are blocked; pass clear: true or empty string to clear.'
        : 'Type text into one input by selector, then read it back to verify. Password fields and over-maxlength answers are refused; pass clear: true to clear.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          ...elementProperty,
          text: { type: 'string' },
          clear: { type: 'boolean', description: 'clear the input field' },
        },
        required: [elementKey],
      },
    },
    {
      name: 'page_select',
      description: options.elements
        ? 'Choose an option in one select ref from the latest page_read, then verify it. Refs stay usable until the page navigates.'
        : 'Choose one option of a <select> dropdown, matched by the option\'s label or value, then read the selection back to verify. The full option list is reported when nothing matches.',
      gated: true,
      input: { type: 'object', properties: { ...elementProperty, value: { type: 'string', description: 'option label or value to select' } }, required: [elementKey, 'value'] },
    },
    {
      name: 'page_press',
      description: 'Send a trusted keyboard key or shortcut chord (e.g. Enter, Escape, Tab, Control+A, ArrowDown), optionally focusing an element first.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'key or modifier combo (e.g. Enter, Escape, Control+A)' },
          ...elementProperty,
        },
        required: ['key'],
      },
    },
    {
      name: 'page_scroll',
      description: 'Scroll the page or a scrollable element container, or scroll an element into view, and return updated scroll metrics.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
          amount: { type: 'number', description: 'pixels to scroll (defaults to 80% of viewport)' },
          ...elementProperty,
        },
      },
    },
    {
      name: 'page_hover',
      description: 'Move the pointer over an element to trigger hover menus, tooltips, or hover states.',
      gated: true,
      input: {
        type: 'object',
        properties: elementProperty,
        required: [elementKey],
      },
    },
    {
      name: 'page_wait',
      description: 'Wait for text, a selector state (visible/hidden/attached), a URL substring, or a fixed duration (max 30s).',
      gated: false,
      input: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          selector: { type: 'string' },
          state: { type: 'string', enum: ['visible', 'hidden', 'attached'] },
          url: { type: 'string' },
          ms: { type: 'number' },
          timeoutMs: { type: 'number' },
        },
      },
    },
    {
      name: 'page_screenshot',
      description: 'Capture a PNG screenshot of the viewport, full page, or one element; pass annotate: true to overlay Set-of-Marks (e1, e2, ...) bounding-box labels.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean' },
          annotate: { type: 'boolean', description: 'temporarily overlay Set-of-Marks ref labels during capture' },
          ...elementProperty,
        },
      },
    },
    {
      name: 'page_history',
      description: 'Navigate browser history back, forward, or reload the active tab.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['back', 'forward', 'reload'] },
        },
        required: ['direction'],
      },
    },
    {
      name: 'page_console',
      description: 'Read buffered console messages and uncaught exceptions captured for this tab.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          clear: { type: 'boolean' },
          level: { type: 'string', enum: ['all', 'error', 'warning', 'log'] },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'page_network',
      description: 'Read buffered network responses and failed requests captured for this tab.',
      gated: false,
      input: {
        type: 'object',
        properties: {
          clear: { type: 'boolean' },
          failedOnly: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'page_eval',
      description: 'Evaluate an origin-gated JavaScript expression in the active tab and return its JSON-serializable value.',
      gated: true,
      input: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
        },
        required: ['expression'],
      },
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
        return name === 'page_screenshot' ? result : capResult(result)
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
