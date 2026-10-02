// Deterministic autonomy policy. The model can request an action; only this
// code decides whether Troy may execute it.

export const SENSITIVE_PATTERNS = Object.freeze({
  secret: /password|passcode|passkey|one[- ]?time(?: code)?|\botp\b|\bpin\b|verification[- ]?code|security[- ]?code|recovery[- ]?(?:code|phrase)|seed[- ]?phrase|private[- ]?key|api[- ]?key|secret[- ]?key|auth[- ]?token/i,
  payment: /card[- ]?number|credit[- ]?card|debit[- ]?card|\bcvv\b|\bcvc\b|expiry|expiration|routing[- ]?number|bank[- ]?account|account[- ]?number|iban|swift|sort[- ]?code|payment|billing/i,
  identity: /social[- ]security|\bssn\b|national[- ]id|passport|driver'?s?[- ]?licen[cs]e|tax[- ]id|aadhaar|government[- ]id|identity[- ]?document/i,
})

export const SENSITIVE_DATA_PATTERN = new RegExp(
  Object.values(SENSITIVE_PATTERNS).map((pattern) => `(?:${pattern.source})`).join('|'),
  'i',
)

const MESSAGE_PATTERN = /\bsend\b|\bmessage\b|\bemail\b|\bchat\b|\bcomment\b|\breply\b|\bpublish\b|\bpost\b|\bapply\b|\bapplication\b|cover[- ]letter/i
const ACCOUNT_PATTERN = /create account|delete account|close account|change password|reset password|change email|two[- ]?factor|\b2fa\b|recovery|oauth|authorize|grant access|sign up|register/i
const COMMERCE_PATTERN = /buy|purchase|checkout|place (the )?order|pay|transfer|wire|trade|sell|gambl|bet|subscribe|unsubscribe|cancel subscription/i
const DESTRUCTIVE_PATTERN = /delete|remove permanently|destroy|erase|cancel (order|booking|reservation)|terminate/i

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function exactOrigin(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * @param {unknown} target
 * @param {Iterable<string>} allowedOrigins
 */
export function originAllowed(target, allowedOrigins) {
  const origin = exactOrigin(target)
  if (!origin) return false
  return new Set(allowedOrigins).has(origin)
}

/** @param {Record<string, any>} item */
function descriptor(item) {
  return [
    item.text,
    item.label,
    item.ariaLabel,
    item.name,
    item.id,
    item.role,
    item.autocomplete,
    item.inputMode,
    item.placeholder,
    item.href,
    item.formAction,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' | ')
}

/**
 * @param {Record<string, any>} item
 * @returns {string | null}
 */
export function sensitiveElementReason(item) {
  const type = String(item.type ?? '').toLowerCase()
  const autocomplete = String(item.autocomplete ?? '').toLowerCase()
  const words = descriptor(item)

  if (type === 'password') return 'password fields are never operated by the agent'
  if (type === 'file' || String(item.tag ?? '').toLowerCase() === 'input' && type === 'file') {
    return 'file uploads are never operated by the agent'
  }
  if (/cc-|one-time-code|new-password|current-password/.test(autocomplete)) {
    return 'this field is marked for a credential, verification code, or payment card'
  }
  if (SENSITIVE_PATTERNS.secret.test(words)) return 'this control appears to contain a credential, code, or secret'
  if (SENSITIVE_PATTERNS.payment.test(words)) return 'payment and bank fields are never operated by the agent'
  if (SENSITIVE_PATTERNS.identity.test(words)) return 'government identity fields are never operated by the agent'
  return null
}

/**
 * @typedef {{ allowed: true } | { allowed: false, status: 'blocked'|'boundary', code: string, reason: string, origin?: string }} PolicyDecision
 */

/**
 * @param {{
 *   name: string,
 *   item?: Record<string, any>,
 *   targetUrl?: string,
 *   currentUrl?: string,
 *   allowedOrigins: Iterable<string>,
 * }} request
 * @returns {PolicyDecision}
 */
export function authorizeAction(request) {
  const allowed = new Set(request.allowedOrigins)
  if (request.name === 'page_navigate') {
    const origin = exactOrigin(request.targetUrl)
    if (!origin) {
      return { allowed: false, status: 'blocked', code: 'scheme', reason: 'the agent may navigate only to HTTP or HTTPS pages' }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `navigation requested an origin outside this session: ${origin}`,
        origin,
      }
    }
    return { allowed: true }
  }

  const item = request.item ?? {}
  const sensitive = sensitiveElementReason(item)
  if (sensitive) return { allowed: false, status: 'blocked', code: 'sensitive', reason: sensitive }

  const href = String(item.href ?? '')
  if (href) {
    const origin = exactOrigin(href)
    if (origin && !allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `that control would leave the session for ${origin}`,
        origin,
      }
    }
  }

  if (item.download || String(item.type ?? '').toLowerCase() === 'file') {
    return { allowed: false, status: 'blocked', code: 'download', reason: 'downloads and file operations are never autonomous' }
  }
  if (item.defaultSubmit || String(item.type ?? '').toLowerCase() === 'submit') {
    return { allowed: false, status: 'blocked', code: 'submit', reason: 'native form submission is never autonomous' }
  }

  // These labels describe the effect of activating a control. They must not
  // block reversible typing into ordinary fields such as Email or Postcode.
  if (request.name === 'page_click') {
    const words = descriptor(item)
    if (COMMERCE_PATTERN.test(words)) {
      return { allowed: false, status: 'blocked', code: 'commerce', reason: 'purchases, payments, transfers, trades, and subscriptions are never autonomous' }
    }
    if (MESSAGE_PATTERN.test(words)) {
      return { allowed: false, status: 'blocked', code: 'message', reason: 'sending, publishing, posting, commenting, and applications are never autonomous' }
    }
    if (ACCOUNT_PATTERN.test(words)) {
      return { allowed: false, status: 'blocked', code: 'account', reason: 'account, credential, recovery, 2FA, and OAuth changes are never autonomous' }
    }
    if (DESTRUCTIVE_PATTERN.test(words)) {
      return { allowed: false, status: 'blocked', code: 'destructive', reason: 'destructive and cancellation actions are never autonomous' }
    }
  }

  return { allowed: true }
}
