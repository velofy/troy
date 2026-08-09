import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaults, settingsFile, readSettings, writeSettings } from '../src/browser/settings.js'
import {
  shortcutsFile,
  readShortcuts,
  addShortcut,
  removeShortcut,
  normalise,
  MAX_SHORTCUTS,
} from '../src/browser/shortcuts.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-settings-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('settings defaults', () => {
  // The decision this file exists for.
  it('does not remember history unless asked', () => {
    expect(defaults().rememberHistory).toBe(false)
  })

  it('blocks trackers and searches with google out of the box', () => {
    expect(defaults().blockTrackers).toBe(true)
    expect(defaults().searchEngine).toBe('google')
  })

  it('applies those defaults when no settings file exists yet', async () => {
    const dir = await tempDir()
    expect(readSettings(settingsFile(dir))).toEqual(defaults())
  })
})

describe('reading and writing settings', () => {
  it('round-trips a change', async () => {
    const dir = await tempDir()
    const file = settingsFile(dir)
    writeSettings(file, { rememberHistory: true })
    expect(readSettings(file).rememberHistory).toBe(true)
  })

  it('leaves the other settings alone when one changes', async () => {
    const dir = await tempDir()
    const file = settingsFile(dir)
    writeSettings(file, { searchEngine: 'duckduckgo' })
    writeSettings(file, { rememberHistory: true })
    const settings = readSettings(file)
    expect(settings.searchEngine).toBe('duckduckgo')
    expect(settings.rememberHistory).toBe(true)
  })

  it('keeps keys it does not know about, so a newer Troy does not lose them', async () => {
    const dir = await tempDir()
    const file = settingsFile(dir)
    await writeFile(file, JSON.stringify({ rememberHistory: false, somethingNewer: 'keep me' }))
    writeSettings(file, { blockTrackers: false })
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.somethingNewer).toBe('keep me')
  })

  it('falls back to defaults for a corrupt file rather than refusing to start', async () => {
    const dir = await tempDir()
    const file = settingsFile(dir)
    await writeFile(file, 'not json')
    expect(readSettings(file)).toEqual(defaults())
  })

  it('ignores a value of the wrong type', async () => {
    const dir = await tempDir()
    const file = settingsFile(dir)
    await writeFile(file, JSON.stringify({ rememberHistory: 'yes please' }))
    expect(readSettings(file).rememberHistory).toBe(false)
  })
})

describe('shortcuts', () => {
  it('starts empty', async () => {
    const dir = await tempDir()
    expect(readShortcuts(shortcutsFile(dir))).toEqual([])
  })

  it('adds a tile and titles it from the host when no title is given', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    expect(addShortcut(file, { url: 'https://www.example.com/path' })).toEqual([
      { url: 'https://www.example.com/path', title: 'example.com' },
    ])
  })

  it('updates rather than duplicating when the same url is added twice', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    addShortcut(file, { url: 'https://example.com/', title: 'First' })
    const after = addShortcut(file, { url: 'https://example.com/', title: 'Second' })
    expect(after).toHaveLength(1)
    expect(after[0]?.title).toBe('Second')
  })

  it('removes a tile', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    addShortcut(file, { url: 'https://a.example/' })
    addShortcut(file, { url: 'https://b.example/' })
    expect(removeShortcut(file, 'https://a.example/').map((s) => s.url)).toEqual(['https://b.example/'])
  })

  it('stops growing past the point where a grid stops being a shortcut', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    for (let i = 0; i < MAX_SHORTCUTS + 5; i++) addShortcut(file, { url: `https://site${i}.example/` })
    expect(readShortcuts(file)).toHaveLength(MAX_SHORTCUTS)
  })

  // The same hole the address bar refuses, reached through the back door.
  it('refuses a tile that would run script when clicked', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    expect(addShortcut(file, { url: 'javascript:alert(1)' })).toEqual([])
    expect(addShortcut(file, { url: 'data:text/html,<h1>x' })).toEqual([])
    expect(addShortcut(file, { url: 'file:///etc/passwd' })).toEqual([])
  })

  it('assumes https for a bare host', () => {
    expect(normalise('example.com')).toBe('https://example.com/')
  })

  it('treats a corrupt shortcuts file as no shortcuts', async () => {
    const dir = await tempDir()
    const file = shortcutsFile(dir)
    await writeFile(file, '{ not an array')
    expect(readShortcuts(file)).toEqual([])
  })
})
