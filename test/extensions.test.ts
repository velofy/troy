import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findExtensions, readManifest, loadExtensions, summarise } from '../src/browser/extensions.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-ext-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** Write an unpacked extension folder that Chromium would accept. */
async function makeExtension(
  root: string,
  name: string,
  manifest: Record<string, unknown> | string = {},
): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  const body =
    typeof manifest === 'string'
      ? manifest
      : JSON.stringify({ manifest_version: 3, name, version: '1.0.0', ...manifest })
  await writeFile(path.join(dir, 'manifest.json'), body)
  return dir
}

/** A session that records what it was asked to load. */
function fakeSession(behaviour: (dir: string) => Promise<{ id: string; name: string }>) {
  const asked: string[] = []
  return {
    asked,
    extensions: {
      loadExtension: (dir: string) => {
        asked.push(dir)
        return behaviour(dir)
      },
    },
  }
}

describe('findExtensions', () => {
  it('returns nothing when the folder does not exist yet', () => {
    expect(findExtensions('/definitely/not/here')).toEqual([])
  })

  it('finds every folder that has a manifest', async () => {
    const root = await tempDir()
    await makeExtension(root, 'blocker')
    await makeExtension(root, 'inspector')
    expect(findExtensions(root).map((d) => path.basename(d))).toEqual(['blocker', 'inspector'])
  })

  it('ignores a folder with no manifest, which is somebody notes rather than an extension', async () => {
    const root = await tempDir()
    await makeExtension(root, 'real')
    await mkdir(path.join(root, 'scratch'), { recursive: true })
    await writeFile(path.join(root, 'scratch', 'notes.txt'), 'hello')
    expect(findExtensions(root).map((d) => path.basename(d))).toEqual(['real'])
  })

  it('ignores loose files and dotfolders at the top level', async () => {
    const root = await tempDir()
    await makeExtension(root, 'real')
    await writeFile(path.join(root, 'README.md'), 'x')
    await makeExtension(root, '.hidden')
    expect(findExtensions(root).map((d) => path.basename(d))).toEqual(['real'])
  })

  it('returns a stable order, so startup logs do not shuffle', async () => {
    const root = await tempDir()
    await makeExtension(root, 'zulu')
    await makeExtension(root, 'alpha')
    expect(findExtensions(root).map((d) => path.basename(d))).toEqual(['alpha', 'zulu'])
  })
})

describe('readManifest', () => {
  it('reads the name and version', async () => {
    const root = await tempDir()
    const dir = await makeExtension(root, 'blocker', { name: 'Request Blocker', version: '2.3.1' })
    expect(readManifest(dir)).toEqual({
      name: 'Request Blocker',
      version: '2.3.1',
      manifestVersion: 3,
    })
  })

  it('falls back to the folder name when the manifest has none', async () => {
    const root = await tempDir()
    const dir = await makeExtension(root, 'nameless', '{"manifest_version":3,"version":"1.0.0"}')
    expect(readManifest(dir)?.name).toBe('nameless')
  })

  it('returns null for a manifest that is not valid JSON, rather than throwing', async () => {
    const root = await tempDir()
    const dir = await makeExtension(root, 'broken', '{ not json')
    expect(readManifest(dir)).toBeNull()
  })
})

describe('loadExtensions', () => {
  it('loads every extension it finds and reports each one', async () => {
    const root = await tempDir()
    await makeExtension(root, 'one', { name: 'One' })
    await makeExtension(root, 'two', { name: 'Two' })
    const session = fakeSession(async (dir) => ({ id: `id-${path.basename(dir)}`, name: path.basename(dir) }))

    const results = await loadExtensions(session, root)

    expect(session.asked).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.id)).toEqual(['id-one', 'id-two'])
  })

  // A browser that will not start because one folder is broken is worse than
  // a browser missing one extension.
  it('keeps loading the rest when one extension fails', async () => {
    const root = await tempDir()
    await makeExtension(root, 'good')
    await makeExtension(root, 'rotten')
    const session = fakeSession(async (dir) => {
      if (dir.endsWith('rotten')) throw new Error('unsupported manifest key')
      return { id: 'ok', name: 'good' }
    })

    const results = await loadExtensions(session, root)

    expect(results).toHaveLength(2)
    expect(results.find((r) => r.name === 'good')?.ok).toBe(true)
    const failed = results.find((r) => !r.ok)
    expect(failed?.error).toContain('unsupported manifest key')
  })

  it('never grants an extension file access without being asked', async () => {
    const root = await tempDir()
    await makeExtension(root, 'one')
    const seen: Array<Record<string, unknown> | undefined> = []
    const session = {
      extensions: {
        loadExtension: async (_dir: string, options?: Record<string, unknown>) => {
          seen.push(options)
          return { id: 'x', name: 'one' }
        },
      },
    }

    await loadExtensions(session, root)
    expect(seen[0]?.allowFileAccess).toBe(false)
  })

  it('does nothing at all when the folder is empty', async () => {
    const root = await tempDir()
    const session = fakeSession(async () => ({ id: 'x', name: 'x' }))
    expect(await loadExtensions(session, root)).toEqual([])
    expect(session.asked).toEqual([])
  })
})

describe('summarise', () => {
  it('says so plainly when there is nothing installed', () => {
    expect(summarise([])).toBe('no extensions installed')
  })

  it('names what loaded', () => {
    const line = summarise([
      { dir: '/a', ok: true, name: 'One' },
      { dir: '/b', ok: true, name: 'Two' },
    ])
    expect(line).toContain('2 extensions loaded')
    expect(line).toContain('One, Two')
  })

  it('makes a failure visible instead of quietly dropping it', () => {
    const line = summarise([
      { dir: '/a', ok: true, name: 'One' },
      { dir: '/b', ok: false, name: 'Two', error: 'bad manifest' },
    ])
    expect(line).toContain('1 failed')
    expect(line).toContain('Two (bad manifest)')
  })
})
