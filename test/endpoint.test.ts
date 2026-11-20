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
  pidAlive,
  probeEndpoint,
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
  it('round-trips while the browser that wrote it is still running', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    const endpoint = describeEndpoint({ port: 9222, pid: process.pid, version: '0.1.0', now: new Date(0) })

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
    writeEndpoint(file, describeEndpoint({ port: 9222, pid: process.pid, version: '0.1.0' }))
    expect(existsSync(file)).toBe(true)

    clearEndpoint(file)
    expect(existsSync(file)).toBe(false)
    expect(() => clearEndpoint(file)).not.toThrow()
  })

  it('writes atomically so readers never see a half-written file', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    const endpoint = describeEndpoint({ port: 9222, pid: process.pid, version: '0.1.0' })
    writeEndpoint(file, endpoint)
    expect(readEndpoint(file)).toEqual(endpoint)
    const leftovers = (await import('node:fs')).readdirSync(dir).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('a file left by a crashed Troy', () => {
  // clearEndpoint runs on will-quit, so a crash leaves the advertisement
  // behind while nothing is listening. A reader that reports it as live
  // sends an agent at a dead port and blames the browser for it.
  it('reads as no endpoint once the recorded pid is gone', async () => {
    const dir = await tempDir()
    const file = endpointFile(dir)
    const { spawn } = await import('node:child_process')
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()))

    writeEndpoint(file, describeEndpoint({ port: 9222, pid: dead.pid as number, version: '0.1.0' }))
    expect(readEndpoint(file)).toBeNull()
  })
})

describe('pidAlive', () => {
  it('reports this process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('reports a pid nothing answers for as gone', () => {
    // Far beyond any pid the kernel will hand out, so signal 0 can only
    // fail with ESRCH.
    expect(pidAlive(2 ** 31 - 1)).toBe(false)
  })

  it('counts a process we may not signal (someone else\u2019s) as alive', () => {
    const eperm = (): void => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    }
    expect(pidAlive(2 ** 31 - 1, eperm)).toBe(true)
  })

  it('counts ESRCH as gone', () => {
    const esrch = (): void => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }
    expect(pidAlive(2 ** 31 - 1, esrch)).toBe(false)
  })

  it('refuses pid shapes that cannot name a Troy process, without signalling', () => {
    const mustNotRun = (): void => {
      throw new Error('signal must not be called')
    }
    expect(pidAlive(0, mustNotRun)).toBe(false)
    expect(pidAlive(-1, mustNotRun)).toBe(false)
    expect(pidAlive(2.5, mustNotRun)).toBe(false)
  })
})

describe('probeEndpoint', () => {
  it('returns true when /json/version answers 200 ok', async () => {
    let seenUrl = ''
    let seenSignal: AbortSignal | undefined
    const okFetch = async (url: string, init?: { signal?: AbortSignal }) => {
      seenUrl = url
      seenSignal = init?.signal
      return new Response(JSON.stringify({ Browser: 'Chrome/130' }), { status: 200 })
    }

    await expect(probeEndpoint(9333, okFetch)).resolves.toBe(true)
    expect(seenUrl).toBe('http://127.0.0.1:9333/json/version')
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal?.aborted).toBe(false)
  })

  it('returns false on non-200 responses', async () => {
    const notFound = async () => new Response('not found', { status: 404 })
    const serverErr = async () => new Response('boom', { status: 500 })

    await expect(probeEndpoint(9333, notFound)).resolves.toBe(false)
    await expect(probeEndpoint(9333, serverErr)).resolves.toBe(false)
  })

  it('returns false on network errors', async () => {
    const refused = async (): Promise<{ ok: boolean }> => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }
    const syncThrow = (): Promise<{ ok: boolean }> => {
      throw new Error('socket closed')
    }

    await expect(probeEndpoint(9333, refused)).resolves.toBe(false)
    await expect(probeEndpoint(9333, syncThrow)).resolves.toBe(false)
  })

  it('aborts and returns false when the probe times out', async () => {
    let aborted = false
    const stalled = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<{ ok: boolean }>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })

    const start = Date.now()
    await expect(probeEndpoint(9333, stalled, 30)).resolves.toBe(false)
    expect(aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('returns false on timeout even if fetchImpl ignores AbortSignal', async () => {
    const uncooperative = () => new Promise<{ ok: boolean }>(() => undefined)

    const start = Date.now()
    await expect(probeEndpoint(9333, uncooperative, 30)).resolves.toBe(false)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('refuses invalid ports without calling fetch', async () => {
    const mustNotRun = async (): Promise<{ ok: boolean }> => {
      throw new Error('fetch must not be called')
    }
    await expect(probeEndpoint(0, mustNotRun)).resolves.toBe(false)
    await expect(probeEndpoint(-1, mustNotRun)).resolves.toBe(false)
    await expect(probeEndpoint(65536, mustNotRun)).resolves.toBe(false)
    await expect(probeEndpoint(9222.5, mustNotRun)).resolves.toBe(false)
    await expect(probeEndpoint(Number.NaN, mustNotRun)).resolves.toBe(false)
  })
})
