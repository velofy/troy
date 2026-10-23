import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveFixtures } from './server.js'
import { refusalFor } from '../scripts/guards.mjs'

/**
 * The verified action layer in scripts/. Two levels:
 *
 *  - refusalFor is the pure guard list, so its rules are unit-testable.
 *  - fill/click/detect are CLIs, so they are driven the only honest way:
 *    as real subprocesses against a real headless Chromium with its
 *    debugging port open, exactly as an agent drives them. Nothing here
 *    mocks the page, because the bugs being guarded against (a readonly
 *    field, a maxlength of zero, a disabled button) live in the page.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_PATH = '/fill-fields.html'

let browserProc: ChildProcess
let cdpUrl: string
let profileDir: string
let fixtures: { url: string; close: () => Promise<void> }

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/**
 * Run one of the scripts as a subprocess would, wired to the test browser.
 *
 * Async on purpose: spawnSync would block this process's event loop, and
 * the fixture server lives in this process, so a synchronous wait for a
 * script that is itself waiting on the fixture server is a deadlock.
 */
function run(script: string, args: string[], input = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
      env: { ...process.env, APPLY_FILL_CDP: cdpUrl },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
    // A script that dies before draining stdin (a refusal, for instance)
    // must not take the test down with EPIPE.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

beforeAll(async () => {
  fixtures = await serveFixtures()
  const port = await freePort()
  profileDir = await mkdtemp(path.join(tmpdir(), 'troy-scripts-'))
  cdpUrl = `http://127.0.0.1:${port}`

  browserProc = spawn(
    chromium.executablePath(),
    [
      // --no-sandbox because this Chromium runs in CI containers and
      // sandboxed test environments where the layer1 sandbox cannot engage;
      // it touches only the local fixture server and nothing else.
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  // The same readiness rule launch.mjs uses: CDP answering on HTTP is what
  // makes the browser drivable, not the process merely existing.
  const deadline = Date.now() + 30_000
  for (;;) {
    if (browserProc.exitCode !== null) throw new Error('headless chromium exited during startup')
    try {
      const res = await fetch(`${cdpUrl}/json/version`)
      if (res.ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('headless chromium never answered on its CDP port')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // Open the fixture the way an agent would, through the allowlisted tool.
  // The timeout absorbs a cold browser on a loaded CI runner; the tool's
  // own 30s default is tuned for a warm one.
  const opened = await run('goto.mjs', [
    '--target', 'generic', '--allow-host', '127.0.0.1',
    '--url', `${fixtures.url}${PAGE_PATH}`,
    '--timeout', '60000',
  ])
  if (opened.status !== 0) throw new Error(`goto failed: ${opened.stderr}`)
}, 60_000)

afterAll(async () => {
  browserProc?.kill()
  await fixtures?.close()
  // Chromium tears its profile directory down asynchronously after SIGTERM,
  // so the removal may need a retry to win that race.
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('refusalFor', () => {
  it('allows an ordinary editable field', () => {
    expect(refusalFor({ tag: 'input', type: 'text', maxLength: null, text: '' }, 'hello')).toBeNull()
    expect(refusalFor({ tag: 'textarea', maxLength: 5 }, 'hi')).toBeNull()
  })

  it('says which element when the selector matched nothing', () => {
    expect(refusalFor(null)).toBe('element not found for that selector')
  })

  it('refuses submit-shaped elements and password fields', () => {
    expect(refusalFor({ tag: 'button', type: 'submit' })).toMatch(/never submits/)
    expect(refusalFor({ tag: 'input', type: 'password' })).toMatch(/password/)
  })

  it('refuses readonly and disabled fields rather than letting the fill fail opaquely', () => {
    expect(refusalFor({ tag: 'input', type: 'text', readOnly: true })).toMatch(/readonly/)
    expect(refusalFor({ tag: 'textarea', disabled: true })).toMatch(/disabled/)
  })

  it('treats maxlength 0 as a cap of zero, not as no cap', () => {
    expect(refusalFor({ tag: 'input', type: 'text', maxLength: 0 }, 'hi')).toMatch(/caps at 0/)
  })

  it('ignores a maxlength that is not a number, as before', () => {
    expect(refusalFor({ tag: 'input', type: 'text', maxLength: Number.NaN }, 'hi')).toBeNull()
  })
})

describe('fill.mjs against a real page', () => {
  it('fills an ordinary field and verifies the value landed', async () => {
    const res = await run('fill.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#plain'], 'hello world')
    expect(res.status).toBe(0)
    expect(parseJson(res.stdout).ok).toBe(true)
  })

  it('refuses a readonly field up front, with a reason', async () => {
    const res = await run('fill.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#ro'], 'hello')
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/readonly/)
  })

  it('refuses a disabled field up front, with a reason', async () => {
    const res = await run('fill.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#dis'], 'hello')
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/disabled/)
  })

  it('refuses text into a maxlength=0 field instead of "verifying" it', async () => {
    const res = await run('fill.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#cap0'], 'hello')
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/caps at 0/)
  })
})

describe('click.mjs against a real page', () => {
  it('refuses a disabled control with a reason, rather than reporting an unverifiable click', async () => {
    const res = await run('click.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#stuck'])
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/disabled/)
  })

  it('clicks a live control and verifies the page changed', async () => {
    const res = await run('click.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1', '--selector', '#toggle'])
    expect(res.status).toBe(0)
    expect(parseJson(res.stdout).ok).toBe(true)
  })
})

describe('detect.mjs against a real page', () => {
  it('states whether each field can take text at all', async () => {
    const res = await run('detect.mjs', ['--target', 'generic', '--allow-host', '127.0.0.1'])
    expect(res.status).toBe(0)
    const fields = parseJson(res.stdout).fields as Array<Record<string, unknown>>
    const plain = fields.find((f) => f.selector === '#plain')
    expect(plain).toMatchObject({ disabled: false, readOnly: false })
    // The generic target's skipSelector excludes readonly and disabled
    // fields, so what remains is capped but editable: maxLength 0 is a fact
    // worth reporting, not a reason to hide the field.
    const cap0 = fields.find((f) => f.selector === '#cap0')
    expect(cap0).toMatchObject({ disabled: false, readOnly: false, maxLength: 0 })
  })
})
