import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authorizeAction, exactOrigin, originAllowed, sensitiveElementReason, validateUploadFiles } from '../src/agent/policy.js'

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

  it('permits submit/commit clicks when allowSubmit is true while still blocking sensitive, download, and cross-origin', () => {
    for (const item of [
      { tag: 'button', text: 'Place order' },
      { tag: 'button', text: 'Send message' },
      { tag: 'button', text: 'Delete account' },
      { tag: 'button', text: 'Remove permanently' },
      { tag: 'button', text: 'Continue', defaultSubmit: true },
    ]) {
      expect(authorizeAction({ name: 'page_click', item, allowSubmit: true, allowedOrigins: allowed })).toEqual({ allowed: true })
    }

    // Still hard-blocked even with allowSubmit: true
    expect(authorizeAction({
      name: 'page_click',
      item: { tag: 'input', type: 'password', label: 'Password' },
      allowSubmit: true,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, code: 'sensitive' })

    expect(authorizeAction({
      name: 'page_click',
      item: { tag: 'a', text: 'Report', download: true },
      allowSubmit: true,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, code: 'download' })

    expect(authorizeAction({
      name: 'page_click',
      item: { tag: 'a', text: 'Checkout', href: 'https://other.example/pay' },
      allowSubmit: true,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'boundary', code: 'origin' })

    expect(authorizeAction({
      name: 'page_navigate',
      targetUrl: 'javascript:alert(1)',
      allowSubmit: true,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, code: 'scheme' })
  })

  it('origin-gates page_eval to allowed HTTP(S) origins only', () => {
    expect(authorizeAction({
      name: 'page_eval',
      currentUrl: 'https://example.com/app',
      allowedOrigins: allowed,
    })).toEqual({ allowed: true })

    expect(authorizeAction({
      name: 'page_eval',
      currentUrl: 'https://evil.example/app',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'boundary', code: 'origin' })

    expect(authorizeAction({
      name: 'page_eval',
      currentUrl: 'file:///etc/passwd',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'blocked', code: 'scheme' })
  })

  it('allows page_upload on <input type="file"> for allowed origins while keeping page_fill/page_click blocked', () => {
    const fileInput = { tag: 'input', type: 'file', name: 'resume' }
    expect(authorizeAction({
      name: 'page_upload',
      item: fileInput,
      currentUrl: 'https://example.com/apply',
      allowedOrigins: allowed,
    })).toEqual({ allowed: true })

    // Origin boundary still enforced on page_upload
    expect(authorizeAction({
      name: 'page_upload',
      item: fileInput,
      currentUrl: 'https://evil.example/apply',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'boundary', code: 'origin' })

    // Non-file inputs refused on page_upload
    expect(authorizeAction({
      name: 'page_upload',
      item: { tag: 'input', type: 'text', name: 'name' },
      currentUrl: 'https://example.com/apply',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'blocked', code: 'upload' })

    // page_fill and page_click remain blocked on file inputs
    expect(authorizeAction({
      name: 'page_fill',
      item: fileInput,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, code: 'sensitive' })
    expect(authorizeAction({
      name: 'page_click',
      item: fileInput,
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, code: 'sensitive' })
  })

  it('origin-gates page_drag and coordinate page_click', () => {
    expect(authorizeAction({
      name: 'page_drag',
      currentUrl: 'https://example.com/board',
      allowedOrigins: allowed,
    })).toEqual({ allowed: true })

    expect(authorizeAction({
      name: 'page_drag',
      currentUrl: 'https://other.example/board',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'boundary', code: 'origin' })

    expect(authorizeAction({
      name: 'page_click',
      currentUrl: 'https://example.com/canvas',
      allowedOrigins: allowed,
    })).toEqual({ allowed: true })

    expect(authorizeAction({
      name: 'page_click',
      currentUrl: 'https://other.example/canvas',
      allowedOrigins: allowed,
    })).toMatchObject({ allowed: false, status: 'boundary', code: 'origin' })
  })
})

describe('validateUploadFiles', () => {
  it('accepts regular files and rejects empty, oversized, missing, directory, and sensitive paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troy-upload-policy-'))
    try {
      const okFile = path.join(tmpDir, 'report.txt')
      fs.writeFileSync(okFile, 'hello world')

      const okRes = validateUploadFiles([okFile])
      expect(okRes.ok).toBe(true)
      if (okRes.ok) {
        expect(okRes.files).toHaveLength(1)
        expect(path.basename(okRes.files[0])).toBe('report.txt')
      }

      // Empty / invalid / too many
      expect(validateUploadFiles([]).ok).toBe(false)
      expect(validateUploadFiles('not-an-array').ok).toBe(false)
      expect(validateUploadFiles(Array.from({ length: 21 }, () => okFile)).ok).toBe(false)

      // Missing file & directory
      expect(validateUploadFiles([path.join(tmpDir, 'does-not-exist.txt')]).ok).toBe(false)
      expect(validateUploadFiles([tmpDir]).ok).toBe(false)

      // Hard-blocked sensitive secret paths
      const blockedPaths = [
        '/home/user/.ssh/id_rsa',
        '/home/user/.ssh/id_ed25519',
        '~/.ssh/id_rsa',
        '/home/user/.aws/credentials',
        '/home/user/.gnupg/secring.gpg',
        '/home/user/.kube/config',
        '/home/user/.config/gcloud/credentials.db',
        '/etc/shadow',
        '/etc/passwd',
        path.join(tmpDir, '.env'),
        path.join(tmpDir, '.env.local'),
        path.join(tmpDir, 'agent-endpoint.json'),
        path.join(tmpDir, 'agent-keys.json'),
        path.join(tmpDir, 'server.pem'),
        path.join(tmpDir, 'private.key'),
      ]
      for (const p of blockedPaths) {
        const res = validateUploadFiles([p])
        expect(res.ok, `expected ${p} to be blocked`).toBe(false)
        if (!res.ok) expect(res.blocked, `expected ${p} blocked=true`).toBe(true)
      }

      // Symlink to a sensitive file is also blocked via realpathSync
      const envFile = path.join(tmpDir, '.env')
      fs.writeFileSync(envFile, 'SECRET=1')
      const linkPath = path.join(tmpDir, 'harmless.txt')
      fs.symlinkSync(envFile, linkPath)
      const linkRes = validateUploadFiles([linkPath])
      expect(linkRes.ok).toBe(false)
      if (!linkRes.ok) expect(linkRes.blocked).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
