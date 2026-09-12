import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatError, appendLog, installSafetyNet } from '../src/browser/resilience.js'

/**
 * The safety net is the difference between one bad handler and "Troy quit
 * unexpectedly", so it is tested as its own unit rather than only through
 * the app, where reproducing a main-process crash means killing the suite.
 */

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'troy-resilience-'))
  cleanups.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('formatError', () => {
  it('records the name, message and stack of a real error', () => {
    const line = formatError('uncaughtException', new TypeError('nope'), new Date(0))
    expect(line).toContain('1970-01-01T00:00:00.000Z')
    expect(line).toContain('uncaughtException')
    expect(line).toContain('TypeError: nope')
    expect(line).toContain('at ')
  })

  it('handles a thrown non-error without throwing itself', () => {
    expect(formatError('unhandledRejection', 'just a string', new Date(0))).toContain('just a string')
    expect(formatError('unhandledRejection', undefined, new Date(0))).toContain('undefined')
    expect(formatError('unhandledRejection', { odd: true }, new Date(0))).toContain('object')
  })

  it('ends with a newline, so entries do not run together', () => {
    expect(formatError('scope', new Error('one'), new Date(0)).endsWith('\n')).toBe(true)
  })
})

describe('appendLog', () => {
  it('creates the file and its directory on first write', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'nested', 'troy-errors.log')
    appendLog(file, 'first\n')
    expect(await readFile(file, 'utf8')).toBe('first\n')
  })

  it('appends rather than replacing', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'log')
    appendLog(file, 'one\n')
    appendLog(file, 'two\n')
    expect(await readFile(file, 'utf8')).toBe('one\ntwo\n')
  })

  it('trims a log that has grown large, so it cannot fill the disk', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'log')
    await writeFile(file, 'x'.repeat(600 * 1024))
    appendLog(file, 'fresh\n')
    const contents = await readFile(file, 'utf8')
    expect(contents).toBe('fresh\n')
    expect((await stat(file)).size).toBeLessThan(1024)
  })
})

describe('installSafetyNet', () => {
  it('keeps the process alive through an uncaught exception and records it', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'errors.log')
    const seen: string[] = []

    // Vitest installs its own handler; take it off for the duration so this
    // test observes what Electron's main process would.
    const existing = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const remove = installSafetyNet({ logFile: file, onError: (scope) => seen.push(scope) })
    cleanups.push(() => {
      remove()
      for (const listener of existing) process.on('uncaughtException', listener)
    })

    process.emit('uncaughtException', new Error('a handler threw'))

    expect(seen).toEqual(['uncaughtException'])
    expect(await readFile(file, 'utf8')).toContain('a handler threw')
  })

  it('records an unhandled rejection too', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'errors.log')
    const existing = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    const remove = installSafetyNet({ logFile: file })
    cleanups.push(() => {
      remove()
      for (const listener of existing) process.on('unhandledRejection', listener)
    })

    process.emit('unhandledRejection', new Error('nobody caught this'), Promise.resolve())

    expect(await readFile(file, 'utf8')).toContain('nobody caught this')
  })

  it('survives a log it cannot write, because losing the log must not crash the browser', () => {
    const write = () => {
      throw new Error('disk is full')
    }
    const remove = installSafetyNet({ logFile: '/nowhere/at/all.log', write })
    cleanups.push(remove)

    const existing = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    for (const listener of existing) process.on('uncaughtException', listener)

    expect(() => {
      const handlers = process.listeners('uncaughtException')
      const ours = handlers[handlers.length - 1] as (err: unknown) => void
      ours(new Error('original problem'))
    }).not.toThrow()
  })

  it('survives an onError callback that itself throws', () => {
    const remove = installSafetyNet({
      logFile: 'ignored',
      write: () => undefined,
      onError: () => {
        throw new Error('reporting failed')
      },
    })
    cleanups.push(remove)

    const handlers = process.listeners('uncaughtException')
    const ours = handlers[handlers.length - 1] as (err: unknown) => void
    expect(() => ours(new Error('original problem'))).not.toThrow()
  })

  it('removes its handlers when told to, leaving no listener leak', () => {
    const before = process.listenerCount('uncaughtException')
    const remove = installSafetyNet({ logFile: 'ignored', write: () => undefined })
    expect(process.listenerCount('uncaughtException')).toBe(before + 1)
    remove()
    expect(process.listenerCount('uncaughtException')).toBe(before)
  })
})
