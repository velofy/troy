// Deterministic autonomy policy. The model can request an action; only this
// code decides whether Troy may execute it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MAX_UPLOAD_FILES = 20

const BLOCKED_UPLOAD_PATTERNS = [
  { pattern: /(^|\/)\.ssh(\/|$)/i, label: 'SSH directory' },
  { pattern: /(^|\/)\.aws(\/|$)/i, label: 'AWS credentials directory' },
  { pattern: /(^|\/)\.gnupg(\/|$)/i, label: 'GnuPG directory' },
  { pattern: /(^|\/)\.kube(\/|$)/i, label: 'Kubernetes config directory' },
  { pattern: /(^|\/)\.config\/gcloud(\/|$)/i, label: 'GCloud config directory' },
  { pattern: /^\/etc\/shadow$/i, label: '/etc/shadow' },
  { pattern: /^\/etc\/passwd$/i, label: '/etc/passwd' },
  { pattern: /(^|\/)\.env(\.[^/]*)?$/i, label: '.env file' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.[^/]*)?$/i, label: 'SSH private key' },
  { pattern: /(^|\/)agent-endpoint\.json$/i, label: 'Troy agent endpoint token file' },
  { pattern: /(^|\/)agent-keys\.json$/i, label: 'Troy agent keys file' },
  { pattern: /\.(pem|key)$/i, label: 'private key file' },
]

/**
 * Normalize a filesystem path to forward slashes for cross-platform matching.
 *
 * @param {string} p
 */
function toPosixPath(p) {
  return p.replace(/\\/g, '/')
}

/**
 * Check whether a filesystem path matches any hard-blocked secret location.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function blockedUploadReason(filePath) {
  const normalized = toPosixPath(filePath)
  for (const { pattern, label } of BLOCKED_UPLOAD_PATTERNS) {
    if (pattern.test(normalized)) {
      return `refusing to upload sensitive path (${label}): ${filePath}`
    }
  }
  return null
}

/**
 * Pure, defense-in-depth validator for local file paths supplied to page_upload.
 * Rejects empty/oversized lists, sensitive secret paths (including symlinks to
 * sensitive paths), missing files, and non-regular files (directories, sockets).
 *
 * @param {unknown} files
 * @returns {{ ok: true, files: string[] } | { ok: false, error: string, blocked?: boolean, code?: string }}
 */
export function validateUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'files must be a non-empty array of local file paths' }
  }
  if (files.length > MAX_UPLOAD_FILES) {
    return { ok: false, error: `cannot upload more than ${MAX_UPLOAD_FILES} files at once` }
  }
  /** @type {string[]} */
  const resolvedFiles = []
  for (const raw of files) {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
      return { ok: false, error: 'every upload file path must be a non-empty string' }
    }
    const trimmed = raw.trim()
    const expanded = /^~([\\/]|$)/.test(trimmed)
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed
    const resolved = path.resolve(expanded)
    const directBlocked = blockedUploadReason(resolved)
    if (directBlocked) {
      return { ok: false, blocked: true, code: 'sensitive-path', error: directBlocked }
    }
    /** @type {fs.Stats} */
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      return { ok: false, error: `upload file does not exist: ${trimmed}` }
    }
    if (!stat.isFile()) {
      return { ok: false, error: `upload path must be a regular file, not a directory or special file: ${trimmed}` }
    }
    try {
      const real = fs.realpathSync(resolved)
      const realBlocked = blockedUploadReason(real)
      if (realBlocked) {
        return { ok: false, blocked: true, code: 'sensitive-path', error: realBlocked }
      }
      resolvedFiles.push(real)
    } catch {
      resolvedFiles.push(resolved)
    }
  }
  return { ok: true, files: resolvedFiles }
}

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
 *   allowSubmit?: boolean,
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

  if (request.name === 'page_eval') {
    const origin = exactOrigin(request.currentUrl)
    if (!origin) {
      return { allowed: false, status: 'blocked', code: 'scheme', reason: 'page_eval may run only on HTTP or HTTPS pages' }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `page_eval requested on an origin outside this session: ${origin}`,
        origin,
      }
    }
    return { allowed: true }
  }

  if (request.name === 'page_upload') {
    const origin = exactOrigin(request.currentUrl)
    if (!origin) {
      return { allowed: false, status: 'blocked', code: 'scheme', reason: 'page_upload may run only on HTTP or HTTPS pages' }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `page_upload requested on an origin outside this session: ${origin}`,
        origin,
      }
    }
    const item = request.item ?? {}
    if (String(item.tag ?? '').toLowerCase() !== 'input' || String(item.type ?? '').toLowerCase() !== 'file') {
      return { allowed: false, status: 'blocked', code: 'upload', reason: 'page_upload may target only <input type="file"> elements' }
    }
    return { allowed: true }
  }

  if (
    request.name === 'page_drag' ||
    (request.name === 'page_click' && !request.item && request.currentUrl !== undefined)
  ) {
    const origin = exactOrigin(request.currentUrl)
    if (!origin) {
      return { allowed: false, status: 'blocked', code: 'scheme', reason: `${request.name} may run only on HTTP or HTTPS pages` }
    }
    if (!allowed.has(origin)) {
      return {
        allowed: false,
        status: 'boundary',
        code: 'origin',
        reason: `${request.name} requested on an origin outside this session: ${origin}`,
        origin,
      }
    }
    if (!request.item) return { allowed: true }
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

  const allowSubmit = request.allowSubmit === true
  if (!allowSubmit && (item.defaultSubmit || String(item.type ?? '').toLowerCase() === 'submit')) {
    return { allowed: false, status: 'blocked', code: 'submit', reason: 'native form submission is never autonomous' }
  }

  // These labels describe the effect of activating a control. They must not
  // block reversible typing into ordinary fields such as Email or Postcode.
  if (request.name === 'page_click' && !allowSubmit) {
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
