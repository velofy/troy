import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_BOOKMARKS,
  bookmarksFile,
  isBookmarked,
  readBookmarks,
  toggleBookmark,
  writeBookmarks,
} from '../src/browser/bookmarks.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-bookmarks-'))
  cleanups.push(() => void rm(dir, { recursive: true, force: true }))
  return bookmarksFile(dir)
}

describe('bookmarks', () => {
  it('starts empty and ignores corrupt data', async () => {
    const file = await tempFile()
    expect(readBookmarks(file)).toEqual([])
    await writeFile(file, 'not json')
    expect(readBookmarks(file)).toEqual([])
  })

  it('adds and removes one explicit HTTP page', async () => {
    const file = await tempFile()
    const now = new Date('2026-08-31T12:00:00.000Z')
    const added = toggleBookmark(file, { url: 'https://example.com/a', title: 'Example', now })
    expect(added.bookmarked).toBe(true)
    expect(added.entries).toEqual([
      { url: 'https://example.com/a', title: 'Example', addedAt: now.toISOString() },
    ])
    expect(isBookmarked(readBookmarks(file), 'https://example.com/a')).toBe(true)

    const removed = toggleBookmark(file, { url: 'https://example.com/a', title: 'Example' })
    expect(removed.bookmarked).toBe(false)
    expect(readBookmarks(file)).toEqual([])
  })

  it('refuses non-web addresses', async () => {
    const file = await tempFile()
    expect(toggleBookmark(file, { url: 'file:///tmp/private', title: 'private' })).toEqual({
      bookmarked: false,
      entries: [],
    })
  })

  it('keeps the bounded newest-first list', async () => {
    const file = await tempFile()
    const entries = Array.from({ length: MAX_BOOKMARKS + 25 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Page ${index}`,
      addedAt: new Date(index * 1000).toISOString(),
    }))
    writeBookmarks(file, entries)
    expect(readBookmarks(file)).toHaveLength(MAX_BOOKMARKS)
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(MAX_BOOKMARKS)
  })
})
