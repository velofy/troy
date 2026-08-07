import { describe, it, expect, afterAll } from 'vitest'
import { launchHeadless } from '../src/cdp/playwright.js'

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
})
