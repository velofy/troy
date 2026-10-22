import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  endpointFile,
  describeEndpoint,
  writeEndpoint,
  readEndpoint,
  clearEndpoint,
} from '../src/browser/endpoint.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-endpoint-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('endpointFile', () => {
  it('sits beside the profile, so two profiles cannot be confused', () => {
    expect(endpointFile('/profiles/work')).toBe(path.join('/profiles/work', 'agent-endpoint.json'))
  })
})

describe('describeEndpoint', () => {
  it('gives an agent everything it needs to connect and nothing else', () => {
    const endpoint = describeEndpoint({
      port: 9333,
      pid: 1234,
      version: '0.1.0',
      now: new Date(0),
    })
    expect(endpoint).toEqual({
      port: 9333,
      httpEndpoint: 'http://127.0.0.1:9333',
      webSocketDebuggerUrlHint: 'http://127.0.0.1:9333/json/list',
      pid: 1234,
      version: '0.1.0',
      startedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  it('binds to loopback only, never to every interface', () => {
    const endpoint = describeEndpoint({ port: 9333, pid: 1, version: '0' })
    expect(endpoint.httpEndpoint).toContain('127.0.0.1')
    expect(endpoint.httpEndpoint).not.toContain('0.0.0.0')
  })
})

describe('writing and reading the endpoint', () => {
  it('round-trips', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    const endpoint = describeEndpoint({ port: 9222, pid: 42, version: '0.1.0', now: new Date(0) })

    writeEndpoint(file, endpoint)
    expect(readEndpoint(file)).toEqual(endpoint)
  })

  it('writes readable JSON, because a person may well open it', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    writeEndpoint(file, describeEndpoint({ port: 9222, pid: 42, version: '0.1.0' }))
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('\n  "port": 9222')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('reports no endpoint when Troy is not accepting agent connections', async () => {
    const dir = await tempDir()
    expect(readEndpoint(endpointFile(dir))).toBeNull()
  })

  it('treats a corrupt file as no endpoint rather than throwing', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    writeEndpoint(file, describeEndpoint({ port: 1, pid: 1, version: '0' }))
    await rm(file)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'not json at all')
    expect(readEndpoint(file)).toBeNull()
  })

  // A stale file would send an agent at a port nothing is listening on, and
  // the failure would look like Troy being broken rather than closed.
  it('is removed on quit, and removing it twice is harmless', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    writeEndpoint(file, describeEndpoint({ port: 9222, pid: 42, version: '0.1.0' }))
    expect(existsSync(file)).toBe(true)

    clearEndpoint(file)
    expect(existsSync(file)).toBe(false)
    expect(() => clearEndpoint(file)).not.toThrow()
  })

  it('writes atomically so readers never see a half-written file', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    const endpoint = describeEndpoint({ port: 9222, pid: 42, version: '0.1.0' })
    writeEndpoint(file, endpoint)
    expect(readEndpoint(file)).toEqual(endpoint)
    const leftovers = (await import('node:fs')).readdirSync(dir).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})
