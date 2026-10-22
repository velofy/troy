import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROVIDERS, keysFile, setKey, getKey, keyStatus, clearKey } from '../src/agent/keys.js'

/**
 * The API key store. The one property everything else here serves: the key a
 * user pastes is a credential to their paid account, and it must never be
 * recoverable by reading a file. Electron's safeStorage is the mechanism in
 * the app; these tests substitute a reversible fake so the contract (encrypt
 * before write, refuse when encryption is unavailable) is what gets tested,
 * not the OS keychain.
 */

type Crypt = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(blob: Buffer): string
}

/** Reversible and obviously not plaintext: every byte xored with 0x5a. */
const xor = (buf: Buffer) => Buffer.from(Uint8Array.from(buf, (b) => b ^ 0x5a))

const workingCrypt: Crypt = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
  decryptString: (blob) => xor(blob).toString('utf8'),
}

/** What safeStorage looks like on a machine with no keychain backend. */
const lockedCrypt: Crypt = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('encryption is not available')
  },
  decryptString: () => {
    throw new Error('encryption is not available')
  },
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-keys-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('the key store', () => {
  it('knows exactly the three providers the panel offers', () => {
    expect([...PROVIDERS].sort()).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('lives in its own file, never settings.json', async () => {
    const dir = await tempDir()
    expect(keysFile(dir)).not.toBe(path.join(dir, 'settings.json'))
  })

  it('stores the key through safeStorage, so the file never holds the plaintext', async () => {
    const dir = await tempDir()
    const file = keysFile(dir)
    const key = 'sk-ant-test-abc123xyz'

    const result = setKey(file, workingCrypt, 'anthropic', key)
    expect(result).toEqual({ ok: true })

    const raw = await readFile(file, 'utf8')
    // Neither the key itself nor its base64 spelling may appear in the file.
    expect(raw).not.toContain(key)
    expect(raw).not.toContain(Buffer.from(key, 'utf8').toString('base64'))

    expect(getKey(file, workingCrypt, 'anthropic')).toBe(key)
  })

  it('refuses to store anything at all when OS encryption is unavailable', async () => {
    const dir = await tempDir()
    const file = keysFile(dir)

    const result = setKey(file, lockedCrypt, 'anthropic', 'sk-ant-secret')
    expect('error' in result && result.error).toMatch(/plaintext|encrypt/i)
    // Refusal means refusal: no file, not a file with a plaintext fallback.
    expect(existsSync(file)).toBe(false)
  })

  it('refuses a provider it does not know', async () => {
    const dir = await tempDir()
    const result = setKey(keysFile(dir), workingCrypt, 'mystery', 'sk-x')
    expect('error' in result && result.error).toMatch(/provider/i)
  })

  it('refuses an empty key', async () => {
    const dir = await tempDir()
    const result = setKey(keysFile(dir), workingCrypt, 'openai', '   ')
    expect('error' in result && result.error).toBeTruthy()
  })

  it('reports which providers hold a key without revealing any of them', async () => {
    const dir = await tempDir()
    const file = keysFile(dir)
    setKey(file, workingCrypt, 'openai', 'sk-oai-1')

    const status = keyStatus(file, workingCrypt)
    expect(status.encryptionAvailable).toBe(true)
    expect(status.providers).toEqual({ anthropic: false, openai: true, openrouter: false })
    expect(JSON.stringify(status)).not.toContain('sk-oai-1')
  })

  it('clears one provider and leaves the others alone', async () => {
    const dir = await tempDir()
    const file = keysFile(dir)
    setKey(file, workingCrypt, 'openai', 'sk-oai-1')
    setKey(file, workingCrypt, 'openrouter', 'sk-or-2')

    clearKey(file, 'openai')
    expect(getKey(file, workingCrypt, 'openai')).toBeNull()
    expect(getKey(file, workingCrypt, 'openrouter')).toBe('sk-or-2')
  })

  it('treats a corrupt key file as holding no keys', async () => {
    const dir = await tempDir()
    const file = keysFile(dir)
    await writeFile(file, 'not json at all')
    expect(getKey(file, workingCrypt, 'anthropic')).toBeNull()
    expect(keyStatus(file, workingCrypt).providers.anthropic).toBe(false)
  })
})
