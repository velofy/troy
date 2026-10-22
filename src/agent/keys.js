// Where the agent's API keys live, and the rules they live under.
//
// A pasted key is a credential to a paid account, so the one property this
// module serves is: the key must never be recoverable by reading a file.
// Electron's safeStorage does the encryption in the app; these functions
// take the crypt as an argument instead of importing electron directly,
// because the contract (encrypt before write, refuse when encryption is
// unavailable) is worth testing without an OS keychain.

/** The providers the panel offers. Three, on purpose: every one of them is a
 * place a developer plausibly already has a key, and each extra provider is
 * another settings row to keep honest. */
export const PROVIDERS = new Set(['anthropic', 'openai', 'openrouter'])

import fs from 'node:fs'
import path from 'node:path'

/**
 * The slice of Electron's safeStorage the store needs, injected so tests can
 * substitute a fake instead of standing up an OS keychain.
 *
 * @typedef {object} Crypt
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plain: string) => Buffer} encryptString
 * @property {(blob: Buffer) => string} decryptString
 */

/** @typedef {{ ok: boolean } | { error: string }} KeyResult */

/**
 * @param {string} userDataDir
 * @returns {string}
 */
export function keysFile(userDataDir) {
  // Deliberately not settings.json: the settings file is written often, read
  // by several modules, and may be printed in bug reports. Keys deserve a
  // file nothing else touches.
  return `${userDataDir}/agent-keys.json`
}

/**
 * @param {string} file
 * @returns {Record<string, string>} parsed store, empty on any surprise
 */
function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * Store one provider's key under safeStorage encryption.
 *
 * @param {string} file
 * @param {Crypt} crypt
 * @param {string} provider
 * @param {string} key
 * @returns {KeyResult}
 */
export function setKey(file, crypt, provider, key) {
  if (!PROVIDERS.has(provider)) {
    return { error: `unknown provider ${provider}; expected one of ${[...PROVIDERS].join(', ')}` }
  }
  if (!key || !key.trim()) {
    return { error: 'the key is empty' }
  }
  if (!crypt.isEncryptionAvailable()) {
    // Refusal means refusal. Writing plaintext "just this once" is how a
    // credential ends up in a dotfile forever; no fallback exists here.
    return { error: 'OS-level encryption is unavailable, refusing to store the key in plaintext' }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const store = readStore(file)
  store[provider] = crypt.encryptString(key.trim()).toString('base64')
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
  return { ok: true }
}

/**
 * @param {string} file
 * @param {Crypt} crypt
 * @param {string} provider
 * @returns {string | null}
 */
export function getKey(file, crypt, provider) {
  const stored = readStore(file)[provider]
  if (!stored) return null
  try {
    return crypt.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // Undecryptable (keychain rekeyed, file copied across machines) reads as
    // absent; the panel will ask for the key again rather than fail oddly.
    return null
  }
}

/**
 * Which providers hold a key, without revealing any of them.
 *
 * @param {string} file
 * @param {Crypt} crypt
 * @returns {{ encryptionAvailable: boolean, providers: Record<string, boolean> }}
 */
export function keyStatus(file, crypt) {
  const store = readStore(file)
  /** @type {Record<string, boolean>} */
  const providers = {}
  for (const provider of PROVIDERS) {
    providers[provider] = Boolean(store[provider]) && getKey(file, crypt, provider) !== null
  }
  return { encryptionAvailable: crypt.isEncryptionAvailable(), providers }
}

/**
 * @param {string} file
 * @param {string} provider
 */
export function clearKey(file, provider) {
  const store = readStore(file)
  delete store[provider]
  try {
    fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
  } catch {
    // Nothing stored yet; clearing is then already done.
  }
}
