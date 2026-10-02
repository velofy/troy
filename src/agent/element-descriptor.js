// One live-element descriptor shared by page_read and pre-action inspection.
// Safety metadata and value redaction therefore cannot drift between the two.

import { SENSITIVE_DATA_PATTERN } from './policy.js'

/**
 * A stable, unique selector for one element, as an in-page named function
 * expression (named so it can recurse). An id wins outright; without one the
 * element's position among its tag siblings is the fallback, which survives
 * styling changes that would break class names. Shared between the page_read
 * walk and the page_find query, so both hand out selectors from one rule.
 */
export const SELECTOR_FOR_EXPRESSION = `(function selectorFor(el) {
  if (el.id) return '#' + CSS.escape(el.id)
  const parent = el.parentElement
  if (!parent) return el.tagName.toLowerCase()
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
    disabled: Boolean(el.disabled),
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
