import { describe, it, expect, afterAll } from 'vitest'
import { launchHeadless, listenerCountForTests } from '../src/cdp/playwright.js'

const cdp = await launchHeadless()
afterAll(() => cdp.close())

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

  it('resolves rather than hangs when a navigation does not settle before the timeout', async () => {
    const start = Date.now()
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>', timeoutMs: 1 })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('does not leak navigation listeners across repeated failed navigations', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(cdp.send('Page.navigate', { url: 'not-a-valid-url' })).rejects.toThrow()
    }
    expect(listenerCountForTests(cdp, 'Page.loadEventFired')).toBe(0)
    expect(listenerCountForTests(cdp, 'Page.navigatedWithinDocument')).toBe(0)
  })
})
