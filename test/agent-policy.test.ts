import { describe, expect, it } from 'vitest'
import { authorizeAction, exactOrigin, originAllowed, sensitiveElementReason } from '../src/agent/policy.js'

const allowed = new Set(['https://example.com', 'http://localhost:3000'])

describe('exact origin scope', () => {
  it('keeps scheme, hostname and port exact', () => {
    expect(exactOrigin('https://example.com/a?q=1')).toBe('https://example.com')
    expect(exactOrigin('http://localhost:3000/a')).toBe('http://localhost:3000')
    expect(originAllowed('https://example.com/next', allowed)).toBe(true)
    expect(originAllowed('https://sub.example.com/', allowed)).toBe(false)
    expect(originAllowed('http://example.com/', allowed)).toBe(false)
    expect(originAllowed('https://example.com:444/', allowed)).toBe(false)
    expect(originAllowed('javascript:alert(1)', allowed)).toBe(false)
  })

  it('returns a boundary rather than silently granting a destination', () => {
    expect(authorizeAction({
      name: 'page_navigate',
      targetUrl: 'https://accounts.example.com/login',
      allowedOrigins: allowed,
    })).toEqual({
      allowed: false,
      status: 'boundary',
      code: 'origin',
      reason: 'navigation requested an origin outside this session: https://accounts.example.com',
      origin: 'https://accounts.example.com',
    })
  })
})

describe('irreversible and sensitive action policy', () => {
  it('classifies sensitive field metadata before mutation', () => {
    const cases = [
      { item: { tag: 'input', type: 'password', label: 'Password' }, pattern: /password/i },
      { item: { tag: 'input', type: 'text', autocomplete: 'one-time-code' }, pattern: /credential|verification/i },
      { item: { tag: 'input', type: 'text', label: 'Credit card number' }, pattern: /payment|bank/i },
      { item: { tag: 'input', type: 'text', name: 'social-security-number' }, pattern: /identity/i },
      { item: { tag: 'input', type: 'file', label: 'Upload passport' }, pattern: /file upload/i },
    ]
    for (const { item, pattern } of cases) expect(sensitiveElementReason(item)).toMatch(pattern)
  })

  it('hard-blocks irreversible controls by category', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ tag: 'button', text: 'Place order' }, 'commerce'],
      [{ tag: 'button', text: 'Send message' }, 'message'],
      [{ tag: 'button', text: 'Delete account' }, 'account'],
      [{ tag: 'button', text: 'Remove permanently' }, 'destructive'],
      [{ tag: 'button', text: 'Continue', defaultSubmit: true }, 'submit'],
      [{ tag: 'a', text: 'Report', download: true }, 'download'],
    ]
    for (const [item, code] of cases) {
      const decision = authorizeAction({ name: 'page_click', item, allowedOrigins: allowed })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.code).toBe(code)
    }
  })

  it('allows reversible filling of ordinary Email and Postcode fields', () => {
    for (const item of [
      { tag: 'input', type: 'email', label: 'Email address' },
      { tag: 'input', type: 'text', label: 'Postcode' },
    ]) {
      expect(authorizeAction({ name: 'page_fill', item, allowedOrigins: allowed })).toEqual({ allowed: true })
    }
  })

  it('classifies sensitive placeholders even without labels or autocomplete', () => {
    expect(sensitiveElementReason({ tag: 'input', type: 'text', name: 'code', placeholder: 'One-time code' })).toMatch(/credential|code/i)
  })

  it('allows an ordinary reversible reveal inside scope', () => {
    expect(authorizeAction({
      name: 'page_click',
      item: { tag: 'button', type: 'button', text: 'More details' },
      allowedOrigins: allowed,
    })).toEqual({ allowed: true })
  })

  it('blocks a link whose href crosses the exact-origin scope', () => {
    const decision = authorizeAction({
      name: 'page_click',
      item: { tag: 'a', text: 'Continue', href: 'https://other.example/path' },
      allowedOrigins: allowed,
    })
    expect(decision).toMatchObject({ allowed: false, status: 'boundary', origin: 'https://other.example' })
  })
})
