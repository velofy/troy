import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  historyFile,
  readHistory,
  recordVisit,
  clearHistory,
  writeHistory,
  MAX_HISTORY,
} from '../src/browser/history.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-history-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('history', () => {
  it('starts empty when no file exists', async () => {
    const dir = await tempDir()
    expect(readHistory(historyFile(dir))).toEqual([])
  })

  it('records a visit with title and timestamp', async () => {
    const dir = await tempDir()
    const file = historyFile(dir)
    const when = new Date('2026-01-02T03:04:05.000Z')
    recordVisit(file, { url: 'https://example.com/a', title: 'Example', now: when })
    expect(readHistory(file)).toEqual([
      { url: 'https://example.com/a', title: 'Example', visitedAt: when.toISOString() },
    ])
  })

  it('moves a repeat visit to the front instead of duplicating', async () => {
    const dir = await tempDir()
    const file = historyFile(dir)
    recordVisit(file, { url: 'https://a.example/', title: 'A' })
    recordVisit(file, { url: 'https://b.example/', title: 'B' })
    recordVisit(file, { url: 'https://a.example/', title: 'A again' })
    expect(readHistory(file).map((e) => e.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ])
    expect(readHistory(file)[0]?.title).toBe('A again')
  })

  it('clears the file entirely', async () => {
    const dir = await tempDir()
    const file = historyFile(dir)
    recordVisit(file, { url: 'https://example.com/' })
    clearHistory(file)
    expect(existsSync(file)).toBe(false)
    expect(readHistory(file)).toEqual([])
  })

  it('caps the list so it cannot grow without bound', async () => {
    const dir = await tempDir()
    const file = historyFile(dir)
    const entries = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({
      url: `https://site${i}.example/`,
      title: `Site ${i}`,
      visitedAt: new Date(0).toISOString(),
    }))
    writeHistory(file, entries)
    expect(readHistory(file)).toHaveLength(MAX_HISTORY)
  })

  it('writes readable JSON', async () => {
    const dir = await tempDir()
    const file = historyFile(dir)
    recordVisit(file, { url: 'https://example.com/' })
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"url": "https://example.com/"')
    expect(raw.endsWith('\n')).toBe(true)
  })
})
