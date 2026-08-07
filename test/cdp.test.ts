import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { launchHeadless, listenerCountForTests } from '../src/cdp/playwright.js'

const cdp = await launchHeadless()
afterAll(() => cdp.close())

// Fixture server for the navigation tests below. "/loads" completes
// normally. "/never" writes a response but never ends it, so the raw
// Page.navigate command still resolves (headers arrived) while Chrome never
// fires Page.loadEventFired, since the document's own request never
// finishes. This is the same shape as a javascript: URL, a download, or a
// same-document navigation: send() resolving depends on the timeout race,
// not on load ever firing.
const openSockets = new Set<Socket>()
const fixtureServer = http.createServer((req, res) => {
  if (req.url === '/never') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.write('<html><body>stalled')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<h1 id="a">hi</h1>')
})
fixtureServer.on('connection', (socket) => {
  openSockets.add(socket)
  socket.on('close', () => openSockets.delete(socket))
})
await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
const fixturePort = (fixtureServer.address() as AddressInfo).port

afterAll(async () => {
  for (const socket of openSockets) socket.destroy()
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
})

describe('PlaywrightCdp', () => {
  it('evaluates javascript in the page', async () => {
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>' })
    const text = await cdp.evaluate<string>('document.querySelector("h1").textContent')
    expect(text).toBe('hi')
  })

  it('screenshots and returns a png buffer', async () => {
    const png = await cdp.screenshot()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('surfaces the real error message, not the generic "Uncaught", when the page throws', async () => {
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>' })
    await expect(cdp.evaluate('document.querySelector("nope").textContent')).rejects.toThrow(/TypeError/)
  })

  it('resolves rather than hangs when a navigation never fires loadEventFired', async () => {
    const start = Date.now()
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/never`, timeoutMs: 200 })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('resolves promptly via navigatedWithinDocument for a same-document (#hash) navigation', async () => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/loads` })
    const start = Date.now()
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/loads#section` })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('does not leak navigation listeners across repeated failed navigations', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(cdp.send('Page.navigate', { url: 'not-a-valid-url' })).rejects.toThrow()
    }
    expect(listenerCountForTests(cdp, 'Page.loadEventFired')).toBe(0)
    expect(listenerCountForTests(cdp, 'Page.navigatedWithinDocument')).toBe(0)
  })

  it('does not remove an unrelated cdp.on() listener registered on the same event as a successful navigation', async () => {
    const unsubscribe = cdp.on('Page.loadEventFired', () => undefined)
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>' })
    expect(listenerCountForTests(cdp, 'Page.loadEventFired')).toBe(1)
    unsubscribe()
    expect(listenerCountForTests(cdp, 'Page.loadEventFired')).toBe(0)
  })
})
