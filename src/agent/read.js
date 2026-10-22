// page_read: what the model sees when it asks about the tab.
//
// The expression walks the live DOM once and returns a JSON string: page
// facts, a text preview, and every interactive element with a selector that
// matches exactly one node. Those selectors are the contract between reading
// and acting: the model is only ever allowed to click or fill things it was
// handed here, which closes the door on hallucinated selectors.
//
// A password input may be listed (the model needs to know one exists so it
// does not go hunting), but its value never leaves the page. Everything else
// reports its current value, because "what did I already type" is the first
// question any form-filling turn asks.

/** Hard cap on the text preview, in characters. The full fused read lives
 * elsewhere; this is the model's working snapshot, not an archive. */
const PREVIEW_CHARS = 4000

export const READ_PAGE_EXPRESSION = `(() => {
  const body = document.body
  if (!body) return JSON.stringify({ title: document.title || '', readyState: document.readyState || '', characterCount: 0, linkCount: 0, imageCount: 0, headingCount: 0, textPreview: '', degraded: false, interactive: [] })

  const painted = (body.innerText || '').trim()
  const raw = (body.textContent || '').trim()
  const degraded = painted.length === 0 && raw.length > 0

  // A stable, unique selector per element. An id wins outright; without one,
  // the element's position among its tag siblings is the fallback, which
  // survives styling changes that would break class names.
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id)
    const parent = el.parentElement
    if (!parent) return el.tagName.toLowerCase()
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    const index = sameTag.indexOf(el) + 1
    const base = selectorFor(parent)
    return base + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + index + ')'
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? (el.getAttribute('type') || 'text') : ''
    const editable = tag === 'textarea' || (el.isContentEditable === true) ||
      (tag === 'input' && !['button', 'submit', 'checkbox', 'radio', 'file', 'hidden', 'password', 'range'].includes(type))
    return {
      selector: selectorFor(el),
      tag,
      type,
      name: el.getAttribute('name') || '',
      text: (el.innerText || '').trim().slice(0, 120),
      value: type === 'password' ? '' : String(el.value ?? ''),
      disabled: Boolean(el.disabled),
      // A typeless button only defaults to submitting when a form is
      // actually behind it; outside a form it is inert, and calling it
      // dangerous would refuse half the harmless buttons on the web.
      defaultSubmit: ((tag === 'button' && !type) || type === 'submit') &&
        Boolean(el.closest('form')),
      editable,
      maxLength: el.maxLength >= 0 ? el.maxLength : null,
      readOnly: Boolean(el.readOnly),
      label: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : '') ||
        el.getAttribute('aria-label') || '',
    }
  }

  const interactive = []
  const seen = new Set()
  for (const el of body.querySelectorAll('a[href], button, input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    if (seen.has(el)) continue
    seen.add(el)
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    interactive.push(describe(el))
  }

  return JSON.stringify({
    title: document.title || '',
    readyState: document.readyState || '',
    characterCount: painted.length || raw.length,
    linkCount: body.querySelectorAll('a[href]').length,
    imageCount: body.querySelectorAll('img').length,
    headingCount: body.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    textPreview: (painted || raw).slice(0, ${PREVIEW_CHARS}),
    degraded,
    interactive,
  })
})()`

/**
 * A data: or blob: address carries the whole document inline, so echoing it
 * back would smuggle whatever the page holds (a pasted secret, a fixture's
 * embedded credentials) into the model context. The scheme is the fact that
 * matters; the payload never leaves the browser.
 *
 * @param {string} url
 */
function redactInlineUrl(url) {
  return /^(data|blob):/i.test(url) ? `${url.split(':')[0]}: inline document, address withheld` : url
}

/**
 * Parse the expression's output into the shape the tool layer hands the
 * model. The url and title come from the host rather than the page where the
 * page's own answer would be empty mid-navigation.
 *
 * @param {string} raw JSON string from READ_PAGE_EXPRESSION
 * @param {{ url?: string, title?: string }} [fallbacks]
 */
export function normaliseReadResult(raw, fallbacks = {}) {
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return { error: 'page read returned unparseable data' }
  }
  return {
    url: redactInlineUrl(fallbacks.url ?? ''),
    title: String(parsed.title ?? fallbacks.title ?? ''),
    readyState: String(parsed.readyState ?? ''),
    characterCount: Number(parsed.characterCount ?? 0),
    linkCount: Number(parsed.linkCount ?? 0),
    imageCount: Number(parsed.imageCount ?? 0),
    headingCount: Number(parsed.headingCount ?? 0),
    textPreview: String(parsed.textPreview ?? ''),
    degraded: Boolean(parsed.degraded),
    interactive: Array.isArray(parsed.interactive) ? parsed.interactive : [],
  }
}
