import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The agent socket end to end: a real Electron process, the real endpoint
 * file, real POSTs to it. This is the surface a CLI agent lives on, so the
 * assertions are about what arrives over the wire — refs that work, tabs
 * that stay in the background, a token that gates everything.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const PAGE = `<!doctype html><title>socket fixture</title>
<h1>Catalogue</h1>
<input id="q" type="search" name="q" placeholder="Search products" aria-label="Search the catalogue">
<button id="go" type="button">Search</button>
<a href="/cart" id="cart">Your cart</a>
<script>
document.getElementById('go').addEventListener('click', () => {
  document.title = 'Searched: ' + document.getElementById('q').value
})
</script>`

const CART = `<!doctype html><title>cart</title><h1>Your cart</h1>`

let app: ElectronApplication
let dir: string
let server: Server
let base: string
let endpoint: { agentPort: number; agentToken: string; port: number }

async function post(route: string, body: unknown = {}, token?: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${endpoint.agentPort}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-troy-agent': token ?? endpoint.agentToken,
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

/** The first tab only exists once the chrome page has finished loading, so
 *  callers that arrive the instant the endpoint file lands must poll. */
async function tabList(predicate: (tabs: any[]) => boolean, what: string): Promise<any[]> {
  const deadline = Date.now() + 15_000
  let tabs: any[] = []
  while (Date.now() < deadline) {
    const res = await post('/tabs')
    tabs = res.tabs ?? []
    if (predicate(tabs)) return tabs
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`timed out waiting for ${what}; last tabs: ${JSON.stringify(tabs)}`)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'troy-socket-'))
  // Memory on, so the recall path is exercised against a real store.
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ agentMemory: true }))

  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/cart' ? CART : PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  app = await electron.launch({
    args: [path.join(root, 'src', 'browser', 'main.js'), `--user-data-dir=${dir}`, '--agent'],
    env: { ...process.env, TROY_TEST: '1' },
  })

  const file = path.join(dir, 'agent-endpoint.json')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !existsSync(file)) {
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  expect(existsSync(file)).toBe(true)
  endpoint = JSON.parse(readFileSync(file, 'utf8'))
}, 60_000)

afterAll(async () => {
  await app?.close()
  server?.close()
  await rm(dir, { recursive: true, force: true })
})

describe('the agent socket', () => {
  it('refuses callers without the per-launch token', async () => {
    const denied = await post('/tabs', {}, 'wrong-token')
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/token/)
  })

  it('lists tabs and opens one in the background', async () => {
    const before = await tabList((t) => t.length >= 1, 'the first tab')
    expect(before.length).toBe(1)

    const opened = await post('/open', { url: `${base}/` })
    expect(opened.ok).toBe(true)
    expect(opened.id).toBeGreaterThan(0)

    // The new tab must not be what the person was looking at.
    const tabs = await tabList((t) => t.some((x) => x.id === opened.id), 'the opened tab')
    const mine = tabs.find((t: { id: number }) => t.id === opened.id)
    expect(mine).toBeTruthy()
    expect(mine.active).toBe(false)
  })

  it('reads a tab and hands out refs that actions can use', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)), 'the fixture tab')
    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    expect(mine).toBeTruthy()

    const deadline = Date.now() + 15_000
    let read: any = {}
    while (Date.now() < deadline) {
      read = await post('/tool', { tabId: mine.id, name: 'page_read' })
      if (read.ok && read.interactive?.length) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(read.ok).toBe(true)
    expect(read.url).toContain(base)
    const search = read.interactive.find((i: any) => /search/i.test(i.placeholder || i.ariaLabel || i.text))
    expect(search?.ref).toMatch(/^e\d+$/)

    const filled = await post('/tool', { tabId: mine.id, name: 'page_fill', args: { ref: search.ref, text: 'wireless mouse' } })
    expect(filled.error).toBeUndefined()
    expect(filled.ok).toBe(true)

    // Refs survive the action: the same ref resolves again without a re-read.
    const text = await post('/tool', { tabId: mine.id, name: 'page_text', args: { ref: search.ref } })
    expect(text.ok).toBe(true)
    expect(text.text).toBe('wireless mouse')
  })

  it('finds elements by name without a full read', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)), 'the fixture tab')
    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    const found = await post('/tool', { tabId: mine.id, name: 'page_find', args: { query: 'cart' } })
    expect(found.ok).toBe(true)
    expect(found.items.length).toBeGreaterThan(0)
    expect(found.items[0].ref).toMatch(/^e\d+$/)
    expect(found.items[0].text).toMatch(/cart/i)
  })

  it('remembers what it read and recalls it', async () => {
    const mem = await post('/memory')
    expect(mem.enabled).toBe(true)

    const found = await post('/recall', { query: 'search' })
    expect(found.ok).toBe(true)
    expect(found.elements.length).toBeGreaterThan(0)
    expect(found.elements[0].selector).toBe('#q')
    expect(found.pages.length).toBeGreaterThan(0)
  })

  it('refuses to close a tab it did not open, and closes one it did', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)) && t.some((x) => !x.url.startsWith(base)), 'both tabs')
    const foreign = tabs.find((t: { url: string }) => !t.url.startsWith(base))
    const refused = await post('/close', { tabId: foreign.id })
    expect(refused.ok).toBe(false)

    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    const closed = await post('/close', { tabId: mine.id })
    expect(closed.ok).toBe(true)
  })
})
