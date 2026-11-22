// One live-element descriptor shared by page_read and pre-action inspection.
// Safety metadata and value redaction therefore cannot drift between the two.

import { SENSITIVE_DATA_PATTERN } from './policy.js'

/**
 * Interactive elements discovered by page_read and page_find: native controls
 * plus ARIA interactive roles, <summary>, and keyboard-focusable elements.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Query all matching elements across light DOM, open Shadow DOM (`>>>`), and
 * same-origin <iframe>/<frame> documents (`>>frame>>`).
 * Supports arbitrary nesting (e.g. `#host >>> #frame >>frame>> .inner >>> button`).
 * Cross-origin iframe access is wrapped in try/catch and safely skipped.
 * Throws SyntaxError on empty or malformed selectors so callers treat them
 * identically to bad CSS selectors.
 */
export const DEEP_QUERY_ALL_EXPRESSION = `(function deepQueryAll(root, selector) {
  const raw = String(selector ?? '').trim()
  if (!raw) throw new SyntaxError('empty selector')
  if (!raw.includes('>>>') && !raw.includes('>>frame>>')) {
    return Array.from(root.querySelectorAll(raw))
  }
  const parts = raw.split(/\\s*(>>frame>>|>>>)\\s*/)
  if (parts.length < 3 || parts.length % 2 === 0) {
    throw new SyntaxError('malformed deep selector')
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i].trim()) throw new SyntaxError('malformed deep selector')
  }
  let roots = [root]
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i].trim()
    const op = i + 1 < parts.length ? parts[i + 1] : null
    const next = []
    for (const r of roots) {
      const found = r.querySelectorAll(part)
      for (const el of found) {
        if (op === '>>>') {
          if (el.shadowRoot) next.push(el.shadowRoot)
        } else if (op === '>>frame>>') {
          let frameDoc = null
          try { frameDoc = el.contentDocument || null } catch { frameDoc = null }
          if (frameDoc) next.push(frameDoc)
        } else {
          next.push(el)
        }
      }
    }
    roots = next
    if (roots.length === 0) return []
  }
  return roots
})`

/**
 * Query the first matching element across light DOM, open Shadow DOM, and
 * same-origin iframes.
 */
export const DEEP_QUERY_ONE_EXPRESSION = `(function deepQueryOne(root, selector) {
  const matches = (${DEEP_QUERY_ALL_EXPRESSION})(root, selector)
  return matches[0] || null
})`

/**
 * Collect all interactive elements from a root, every open ShadowRoot, and
 * every accessible same-origin iframe document beneath it, deduplicated in
 * document/shadow/frame traversal order.
 */
export const COLLECT_INTERACTIVE_EXPRESSION = `(function collectInteractive(root) {
  const selector = ${JSON.stringify(INTERACTIVE_SELECTOR)}
  const out = []
  const seen = new Set()
  const visitedRoots = new Set()
  function walk(node) {
    if (!node || visitedRoots.has(node)) return
    visitedRoots.add(node)
    for (const el of node.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el)
        out.push(el)
      }
    }
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot)
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let frameDoc = null
        try { frameDoc = el.contentDocument || null } catch { frameDoc = null }
        if (frameDoc) walk(frameDoc)
      }
    }
  }
  walk(root)
  return out
})`

/**
 * Compute top-level viewport coordinates for any element, walking up nested
 * same-origin iframe chains and summing each frameElement's bounding box
 * (including frame border and padding offsets).
 */
export const GET_VIEWPORT_RECT_EXPRESSION = `(function getViewportRect(el) {
  const r = el.getBoundingClientRect()
  let offsetX = 0
  let offsetY = 0
  let win = el.ownerDocument && el.ownerDocument.defaultView
  while (win && win !== window) {
    let frameEl = null
    try { frameEl = win.frameElement } catch { break }
    if (!frameEl) break
    const fr = frameEl.getBoundingClientRect()
    const parentWin = frameEl.ownerDocument && frameEl.ownerDocument.defaultView
    const style = parentWin && typeof parentWin.getComputedStyle === 'function'
      ? parentWin.getComputedStyle(frameEl)
      : null
    const borderLeft = style ? (parseFloat(style.borderLeftWidth) || 0) : 0
    const borderTop = style ? (parseFloat(style.borderTopWidth) || 0) : 0
    const paddingLeft = style ? (parseFloat(style.paddingLeft) || 0) : 0
    const paddingTop = style ? (parseFloat(style.paddingTop) || 0) : 0
    offsetX += fr.left + borderLeft + paddingLeft
    offsetY += fr.top + borderTop + paddingTop
    win = parentWin
  }
  const left = r.left + offsetX
  const top = r.top + offsetY
  const width = r.width
  const height = r.height
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
})`

/**
 * A stable, unique selector for one element, as an in-page named function
 * expression (named so it can recurse). An id wins outright; without one the
 * element's position among its tag siblings is the fallback, which survives
 * styling changes that would break class names. Open Shadow DOM boundaries
 * are encoded with ` >>> ` and same-origin iframe boundaries with ` >>frame>> `
 * so deepQueryAll resolves back to the exact node.
 * Shared between the page_read walk and the page_find query, so both hand out
 * selectors from one rule.
 */
export const SELECTOR_FOR_EXPRESSION = `(function selectorFor(el) {
  const ownerDoc = el.ownerDocument || document
  const root = typeof el.getRootNode === 'function' ? el.getRootNode() : ownerDoc
  const shadowHost = root && root !== ownerDoc && root.host ? root.host : null
  let frameEl = null
  if (ownerDoc && ownerDoc !== document) {
    try {
      frameEl = ownerDoc.defaultView && ownerDoc.defaultView.frameElement ? ownerDoc.defaultView.frameElement : null
    } catch {
      frameEl = null
    }
  }
  if (el.id) {
    const idSel = '#' + CSS.escape(el.id)
    if (shadowHost) return selectorFor(shadowHost) + ' >>> ' + idSel
    if (frameEl) return selectorFor(frameEl) + ' >>frame>> ' + idSel
    return idSel
  }
  const parent = el.parentElement
  if (!parent) {
    if (shadowHost) {
      const sameTag = Array.from(root.children || []).filter((c) => c.tagName === el.tagName)
      const index = Math.max(1, sameTag.indexOf(el) + 1)
      return selectorFor(shadowHost) + ' >>> ' + el.tagName.toLowerCase() + ':nth-of-type(' + index + ')'
    }
    if (frameEl) {
      return selectorFor(frameEl) + ' >>frame>> ' + el.tagName.toLowerCase()
    }
    return el.tagName.toLowerCase()
  }
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
  const index = sameTag.indexOf(el) + 1
  const base = selectorFor(parent)
  return base + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + index + ')'
})`

export const ELEMENT_DESCRIPTOR_EXPRESSION = `(el) => {
  const tag = el.tagName.toLowerCase()
  const type = tag === 'input' ? (el.getAttribute('type') || 'text') : ''
  const name = el.getAttribute('name') || ''
  const id = el.id || ''
  const ariaLabel = el.getAttribute('aria-label') || ''
  const label = (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : '') || ariaLabel
  const autocomplete = el.getAttribute('autocomplete') || ''
  const inputMode = el.getAttribute('inputmode') || ''
  const placeholder = el.getAttribute('placeholder') || ''
  const role = el.getAttribute('role') || ''
  const text = (el.innerText || '').trim().slice(0, 120)
  const href = tag === 'a' ? String(el.href || '') : ''
  const download = tag === 'a' && el.hasAttribute('download')
  const form = el.closest('form')
  const formAction = String(el.getAttribute('formaction') || form?.action || '')
  const formMethod = String(el.getAttribute('formmethod') || form?.method || '')
  const descriptor = [name, id, label, ariaLabel, autocomplete, inputMode, placeholder, role].join(' ')
  const sensitive = new RegExp(${JSON.stringify(SENSITIVE_DATA_PATTERN.source)}, 'i')
  const valueRedacted = type === 'password' || sensitive.test(descriptor)
  const editable = tag === 'textarea' || el.isContentEditable === true ||
    (tag === 'input' && !['button', 'submit', 'checkbox', 'radio', 'file', 'hidden', 'password', 'range'].includes(type))
  const defaultSubmit = ((tag === 'button' && !type) || type === 'submit') && Boolean(form)
  const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
  const signature = JSON.stringify([
    tag, type, id, name, role, text, label, ariaLabel, autocomplete, inputMode,
    placeholder, href, download, formAction, formMethod, defaultSubmit, editable,
  ])
  return {
    tag,
    type,
    id,
    name,
    role,
    text,
    value: valueRedacted ? '' : String(el.value ?? ''),
    valueRedacted,
    disabled,
    defaultSubmit,
    editable,
    maxLength: el.maxLength >= 0 ? el.maxLength : null,
    readOnly: Boolean(el.readOnly),
    multiple: Boolean(el.multiple),
    label,
    ariaLabel,
    autocomplete,
    inputMode,
    placeholder,
    href,
    download,
    formAction,
    formMethod,
    signature,
  }
}`
