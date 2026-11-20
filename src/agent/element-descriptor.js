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
 * Query all matching elements across light DOM and open Shadow DOM.
 * Supports normal CSS selectors as well as `>>>` shadow-root-piercing chains
 * (e.g. `#host >>> .inner >>> button`). Throws SyntaxError on empty or
 * malformed selectors so callers treat them identically to bad CSS selectors.
 */
export const DEEP_QUERY_ALL_EXPRESSION = `(function deepQueryAll(root, selector) {
  const raw = String(selector ?? '').trim()
  if (!raw) throw new SyntaxError('empty selector')
  if (!raw.includes('>>>')) return Array.from(root.querySelectorAll(raw))
  const parts = raw.split(/\\s*>>>\\s*/)
  if (parts.some((p) => !p.trim())) throw new SyntaxError('malformed deep selector')
  let roots = [root]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    const next = []
    for (const r of roots) {
      const found = r.querySelectorAll(part)
      for (const el of found) {
        if (i < parts.length - 1) {
          if (el.shadowRoot) next.push(el.shadowRoot)
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
 * Query the first matching element across light DOM and open Shadow DOM.
 */
export const DEEP_QUERY_ONE_EXPRESSION = `(function deepQueryOne(root, selector) {
  const matches = (${DEEP_QUERY_ALL_EXPRESSION})(root, selector)
  return matches[0] || null
})`

/**
 * Collect all interactive elements from a root and every open ShadowRoot
 * beneath it, deduplicated in document/shadow traversal order.
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
    }
  }
  walk(root)
  return out
})`

/**
 * A stable, unique selector for one element, as an in-page named function
 * expression (named so it can recurse). An id wins outright; without one the
 * element's position among its tag siblings is the fallback, which survives
 * styling changes that would break class names. Open Shadow DOM boundaries
 * are encoded with ` >>> ` so deepQueryAll resolves back to the exact node.
 * Shared between the page_read walk and the page_find query, so both hand out
 * selectors from one rule.
 */
export const SELECTOR_FOR_EXPRESSION = `(function selectorFor(el) {
  const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null
  const shadowHost = root && root !== document && root.host ? root.host : null
  if (el.id) {
    const idSel = '#' + CSS.escape(el.id)
    return shadowHost ? selectorFor(shadowHost) + ' >>> ' + idSel : idSel
  }
  const parent = el.parentElement
  if (!parent) {
    if (shadowHost) {
      const sameTag = Array.from(root.children || []).filter((c) => c.tagName === el.tagName)
      const index = Math.max(1, sameTag.indexOf(el) + 1)
      return selectorFor(shadowHost) + ' >>> ' + el.tagName.toLowerCase() + ':nth-of-type(' + index + ')'
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
