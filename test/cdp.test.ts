import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import { launchHeadless, listenerCountForTests, connectOverWs } from '../src/cdp/playwright.js'
import { clampClip } from '../src/cdp/clip.js'

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

  it('reports the committed url after a same-document hash change', async () => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/loads` })
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/loads#section` })
    expect(await cdp.url()).toBe(`http://127.0.0.1:${fixturePort}/loads#section`)
  })

  it('disconnects the client without closing the browser on connectOverWs close', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const chosen = (probe.address() as AddressInfo).port
        probe.close(() => resolve(chosen))
      })
    })
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    })
    try {
      for (let i = 0; i < 4; i++) {
        const remote = await connectOverWs(`http://127.0.0.1:${port}`)
        await remote.send('Page.navigate', { url: 'data:text/html,<title>attached</title>' })
        expect(await remote.url()).toContain('data:text/html')
        await remote.close()
      }
      const remote = await connectOverWs(`http://127.0.0.1:${port}`)
      expect(await remote.url()).toBeTruthy()
      await remote.close()
    } finally {
      await browser.close()
    }
  })

  it('clamps partially out-of-bounds screenshot clips to the viewport', async () => {
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>clipped</h1>' })
    const png = await cdp.screenshot({ x: -20, y: -10, w: 120, h: 80 })
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // PNG IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
    // (-20, -10, 120x80) clamped against [0, viewport] yields 100x70 at scale 1.
    expect(png.readUInt32BE(16)).toBe(100)
    expect(png.readUInt32BE(20)).toBe(70)
  })

  it('rejects screenshot clips with non-positive dimensions or outside the viewport', async () => {
    await expect(cdp.screenshot({ x: 0, y: 0, w: 0, h: 50 })).rejects.toThrow(/positive/i)
    await expect(cdp.screenshot({ x: 0, y: 0, w: -10, h: 50 })).rejects.toThrow(/positive/i)
    await expect(cdp.screenshot({ x: 99999, y: 99999, w: 50, h: 50 })).rejects.toThrow(/outside the viewport/i)
  })
})

describe('clampClip', () => {
  const vp = { width: 800, height: 600 }

  it('returns an in-bounds clip unchanged', () => {
    expect(clampClip({ x: 10, y: 20, w: 100, h: 50 }, vp)).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    expect(clampClip({ x: 0, y: 0, w: 800, h: 600 }, vp)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('clamps clips that start before the origin', () => {
    expect(clampClip({ x: -20, y: -10, w: 100, h: 50 }, vp)).toEqual({ x: 0, y: 0, w: 80, h: 40 })
  })

  it('clamps clips that extend past the right or bottom edges', () => {
    expect(clampClip({ x: 750, y: 550, w: 100, h: 100 }, vp)).toEqual({ x: 750, y: 550, w: 50, h: 50 })
  })

  it('clamps a clip larger than the viewport on every side', () => {
    expect(clampClip({ x: -50, y: -25, w: 1000, h: 900 }, vp)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('preserves fractional coordinates inside the viewport', () => {
    expect(clampClip({ x: 10.5, y: 20.25, w: 100.5, h: 50.75 }, vp)).toEqual({
      x: 10.5,
      y: 20.25,
      w: 100.5,
      h: 50.75,
    })
  })

  it('rejects non-finite clip coordinates or dimensions', () => {
    expect(() => clampClip({ x: Number.NaN, y: 0, w: 10, h: 10 }, vp)).toThrow(/finite/i)
    expect(() => clampClip({ x: 0, y: Number.POSITIVE_INFINITY, w: 10, h: 10 }, vp)).toThrow(/finite/i)
    expect(() => clampClip({ x: 0, y: 0, w: Number.NEGATIVE_INFINITY, h: 10 }, vp)).toThrow(/finite/i)
    expect(() => clampClip({ x: 0, y: 0, w: 10, h: Number.NaN }, vp)).toThrow(/finite/i)
  })

  it('rejects zero or negative width or height', () => {
    expect(() => clampClip({ x: 0, y: 0, w: 0, h: 10 }, vp)).toThrow(/positive/i)
    expect(() => clampClip({ x: 0, y: 0, w: 10, h: 0 }, vp)).toThrow(/positive/i)
    expect(() => clampClip({ x: 10, y: 10, w: -50, h: 20 }, vp)).toThrow(/positive/i)
    expect(() => clampClip({ x: 10, y: 10, w: 20, h: -50 }, vp)).toThrow(/positive/i)
  })

  it('throws when the clip falls completely outside the viewport', () => {
    expect(() => clampClip({ x: -100, y: 10, w: 50, h: 50 }, vp)).toThrow(/outside the viewport/i)
    expect(() => clampClip({ x: -50, y: 10, w: 50, h: 50 }, vp)).toThrow(/outside the viewport/i)
    expect(() => clampClip({ x: 10, y: -100, w: 50, h: 50 }, vp)).toThrow(/outside the viewport/i)
    expect(() => clampClip({ x: 800, y: 10, w: 50, h: 50 }, vp)).toThrow(/outside the viewport/i)
    expect(() => clampClip({ x: 10, y: 600, w: 50, h: 50 }, vp)).toThrow(/outside the viewport/i)
  })

  it('rejects invalid viewport dimensions', () => {
    expect(() => clampClip({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 600 })).toThrow(/viewport/i)
    expect(() => clampClip({ x: 0, y: 0, w: 10, h: 10 }, { width: 800, height: -1 })).toThrow(/viewport/i)
    expect(() => clampClip({ x: 0, y: 0, w: 10, h: 10 }, { width: Number.NaN, height: 600 })).toThrow(/viewport/i)
  })
})
